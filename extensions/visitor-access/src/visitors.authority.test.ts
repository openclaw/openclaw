import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { VisitorAccessError } from "./errors.js";
import {
  DAY_MS,
  NOW,
  useVisitorFixtures,
  visitorGate,
  visitorFixture,
  visitorGrant,
} from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";

describe("VisitorAccessService authority", () => {
  useVisitorFixtures();

  it("qualifies legacy records only after a confirmed sweep and preserves qualified access during provider outages", async () => {
    const qualified = visitorGrant("qualified@example.com");
    const legacy = visitorGrant("legacy@example.com", { grantId: undefined });
    const missing = visitorGrant("missing@example.com", { grantId: undefined });
    const fixture = visitorFixture({
      grants: [qualified, legacy, missing],
      emails: [qualified.email, legacy.email],
    });
    await fixture.service.initialize();
    const original = fixture.authorize([qualified.email]);
    for (const grant of [legacy, missing]) {
      expect(() => fixture.authorize([grant.email])).toThrow(/active visitor invitation/);
    }
    fixture.fetcher.mockRejectedValueOnce(new Error("Provider is unavailable"));
    await expect(fixture.service.sweep()).rejects.toBeInstanceOf(VisitorAccessError);
    expect(fixture.grants.get(legacy.email)).toEqual(legacy);
    expect(() => fixture.authorize([legacy.email])).toThrow(/active visitor invitation/);
    expect(() => original.assertCurrent()).not.toThrow();

    await fixture.service.sweep();
    expect(() => fixture.authorize([legacy.email]).assertCurrent()).not.toThrow();
    expect(fixture.grants.get(legacy.email)).toMatchObject({
      ...legacy,
      grantId: expect.any(String),
    });
    expect(fixture.grants.get(missing.email)).toEqual(missing);
    expect(() => fixture.authorize([missing.email])).toThrow(/active visitor invitation/);
    expect(fixture.grants.get(qualified.email)).toEqual(qualified);
    expect(fixture.mutations()).toEqual([]);

    fixture.service.close();
    const restarted = visitorFixture({ grants: [...fixture.grants.values()] });
    restarted.fetcher.mockRejectedValue(new Error("Provider remains unavailable"));
    await restarted.service.initialize();
    for (const grant of [qualified, legacy]) {
      expect(() => restarted.authorize([grant.email]).assertCurrent()).not.toThrow();
    }
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(() => restarted.authorize([missing.email])).toThrow(/active visitor invitation/);
    expect(() => original.assertCurrent()).toThrow(/stopping/);
  });

  it.each(["expiry", "revocation"] as const)(
    "fences %s during a blocked write, then admits queued access",
    async (boundary) => {
      const expiring = boundary === "expiry";
      const grant = visitorGrant(EMAIL, { expiresAt: NOW + (expiring ? 1_000 : DAY_MS) });
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      await fixture.service.initialize();
      const authority = fixture.authorize([grant.email]);
      const gate = visitorGate();
      fixture.cloudflare.beforeWrite = gate.wait;
      const target = expiring ? "other@example.com" : EMAIL;
      const pending = expiring
        ? fixture.invite({ email: target })
        : fixture.revoke({ email: EMAIL });
      await gate.entered;
      const renewal = expiring ? undefined : fixture.invite({ email: EMAIL });
      if (expiring) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(authority.signal.aborted).toBe(true);
      expect(() => authority.assertCurrent()).toThrow(/access ended/);
      expect(() => fixture.authorize([target])).toThrow(/active visitor invitation/);
      gate.release();
      await Promise.all([pending, renewal]);
      expect(() => fixture.authorize([target]).assertCurrent()).not.toThrow();
      expect(() => authority.assertCurrent()).toThrow(/access ended/);
    },
  );

  it("preserves an account grant UUID through login changes, renewal and restart, but never resumes its expired authority", async () => {
    const grant = visitorGrant(42, { githubLogin: "original-login" });
    const other = visitorGrant("other@example.com", { expiresAt: null });
    const fixture = visitorFixture({
      grants: [grant, other],
      emails: [other.email],
      githubAccountIds: [42],
      githubLogin: "renamed-login",
    });
    await fixture.service.initialize();
    const original = fixture.authorize([], [42]);
    const grantId = z.uuid().parse(original.grantId);
    expect(grantId).toBe(grant.grantId);
    expect(() => fixture.authorize(["original-login", "42"])).toThrow(/active visitor invitation/);
    expect(fixture.resume([other.email], grantId, [84])).toBeUndefined();

    await vi.advanceTimersByTimeAsync(DAY_MS / 2);
    await fixture.invite({ github: "renamed-login", days: 30 });
    expect(fixture.grants.get("github:42")).toMatchObject({
      grantId,
      githubAccountId: 42,
      githubLogin: "renamed-login",
      createdAt: grant.createdAt,
      expiresAt: NOW + 30.5 * DAY_MS,
    });
    await vi.advanceTimersByTimeAsync(DAY_MS / 2);
    expect(() => original.assertCurrent()).not.toThrow();
    expect(original.signal.aborted).toBe(false);

    fixture.service.close();
    expect(original.signal.aborted).toBe(true);
    const restarted = visitorFixture({
      grants: [...fixture.grants.values()],
      emails: fixture.emails(),
      githubAccountIds: [42],
      githubLogin: "renamed-login",
    });
    await restarted.service.initialize();
    const resumed = restarted.resume([other.email], grantId, [42]);
    if (!resumed) {
      throw new Error("Expected the saved GitHub account grant to resume");
    }
    expect(resumed.grantId).toBe(grantId);
    expect(() => resumed.assertCurrent()).not.toThrow();
    expect(() => restarted.authorize(["renamed-login"])).toThrow(/active visitor invitation/);

    await vi.advanceTimersByTimeAsync(29.5 * DAY_MS);
    expect(resumed.signal.aborted).toBe(true);
    expect(() => resumed.assertCurrent()).toThrow(/access ended/);
    expect(restarted.resume([other.email], grantId, [42])).toBeUndefined();
    expect(() => restarted.authorize([], [42])).toThrow(/active visitor invitation/);
    expect(() => restarted.authorize([other.email]).assertCurrent()).not.toThrow();

    await restarted.invite({ github: "renamed-login", days: 1 });
    const replacement = restarted.authorize([], [42]);
    expect(replacement.grantId).not.toBe(grantId);
    expect(() => replacement.assertCurrent()).not.toThrow();
    expect(restarted.resume([other.email], grantId, [42])).toBeUndefined();
    expect(() => resumed.assertCurrent()).toThrow(/access ended/);
  });

  it("does not start a durable revocation after closing during the grant read", async () => {
    const grant = visitorGrant(EMAIL);
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    const gate = visitorGate();
    const read = fixture.store.entries.bind(fixture.store);
    fixture.store.entries = async () => {
      await gate.wait();
      return read();
    };
    const revoking = fixture.revoke({ email: grant.email });
    await gate.entered;
    fixture.service.close();
    gate.release();
    await expect(revoking).rejects.toThrow(/stopping/);
    expect(fixture.grants.get(grant.email)).toEqual(grant);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each(["rejected", "committed but response lost"] as const)(
    "preserves the prior grant and lifetime when renewal is %s",
    async (outcome) => {
      const grant = visitorGrant(EMAIL);
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      await fixture.service.initialize();
      const original = fixture.authorize([grant.email]);
      const recorded = structuredClone(fixture.grants.get(grant.email));
      // Dashboard drift makes this renewal require a provider write.
      fixture.cloudflare.policy = undefined;
      fixture.cloudflare.failWrites = outcome === "rejected";
      fixture.cloudflare.loseWriteResponse = outcome === "committed but response lost";

      await expect(fixture.invite({ email: grant.email, days: 2 })).rejects.toBeInstanceOf(
        VisitorAccessError,
      );

      expect(fixture.grants.get(grant.email)).toEqual(recorded);
      expect(() => original.assertCurrent()).not.toThrow();
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(original.signal.aborted).toBe(true);
      expect(() => fixture.authorize([grant.email])).toThrow(/active visitor invitation/);
    },
  );

  it.each(["invite", "renew"] as const)(
    "requires current authority to activate %s after a confirmed provider effect",
    async (operation) => {
      const email = EMAIL;
      const previous = operation === "renew" ? visitorGrant(email) : undefined;
      const fixture = visitorFixture({ grants: previous ? [previous] : [] });

      fixture.cloudflare.afterWrite = () => {
        fixture.revokeAuthority();
      };

      await expect(fixture.invite({ email, days: 2 })).rejects.toThrow(/no longer current/);

      expect(fixture.emails()).toEqual([email]);
      expect(fixture.grants.get(email)).toEqual(
        previous ?? {
          email,
          onboarding: { state: "pending", updatedAt: NOW },
          createdAt: NOW,
          expiresAt: NOW,
        },
      );
    },
  );
});
