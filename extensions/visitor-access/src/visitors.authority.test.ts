import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisitorAccessError } from "./errors.js";
import {
  DAY_MS,
  NOW,
  closeVisitorFixtures,
  visitorFixture,
  visitorGrant,
} from "./visitors.test-support.js";

describe("VisitorAccessService authority", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    closeVisitorFixtures();
    vi.useRealTimers();
  });

  it("qualifies legacy records only after a confirmed sweep and preserves qualified access during provider outages", async () => {
    const qualified = visitorGrant("qualified@example.com");
    const legacy = visitorGrant("legacy@example.com", { grantId: undefined });
    const missing = visitorGrant("missing@example.com", { grantId: undefined });
    const fixture = visitorFixture({
      grants: [qualified, legacy, missing],
      emails: [qualified.email, legacy.email],
    });
    await fixture.service.initialize();
    const original = fixture.service.authorize([qualified.email]);
    for (const grant of [legacy, missing]) {
      expect(() => fixture.service.authorize([grant.email])).toThrow(/active visitor invitation/);
    }
    fixture.fetcher.mockRejectedValueOnce(new Error("Provider is unavailable"));
    await expect(fixture.service.sweep()).rejects.toBeInstanceOf(VisitorAccessError);
    expect(fixture.grants.get(legacy.email)).toEqual(legacy);
    expect(() => fixture.service.authorize([legacy.email])).toThrow(/active visitor invitation/);
    expect(() => original.assertCurrent()).not.toThrow();

    await fixture.service.sweep();
    expect(() => fixture.service.authorize([legacy.email]).assertCurrent()).not.toThrow();
    expect(fixture.grants.get(legacy.email)).toMatchObject({
      ...legacy,
      grantId: expect.any(String),
    });
    expect(fixture.grants.get(missing.email)).toEqual(missing);
    expect(() => fixture.service.authorize([missing.email])).toThrow(/active visitor invitation/);
    expect(fixture.grants.get(qualified.email)).toEqual(qualified);
    expect(fixture.mutations()).toEqual([]);

    fixture.service.close();
    const restarted = visitorFixture({ grants: [...fixture.grants.values()] });
    restarted.fetcher.mockRejectedValue(new Error("Provider remains unavailable"));
    await restarted.service.initialize();
    for (const grant of [qualified, legacy]) {
      expect(() => restarted.service.authorize([grant.email]).assertCurrent()).not.toThrow();
    }
    expect(restarted.fetcher).not.toHaveBeenCalled();
    expect(() => restarted.service.authorize([missing.email])).toThrow(/active visitor invitation/);
    expect(() => original.assertCurrent()).toThrow(/stopping/);
  });

  it("requires a current canonical email grant even when expired policy cleanup fails", async () => {
    const expired = visitorGrant("expired@example.com", { expiresAt: NOW });
    const active = visitorGrant("active@example.com", { githubLogin: "display-only" });
    const fixture = visitorFixture({
      grants: [expired, active],
      emails: [expired.email, active.email],
    });
    expect(() => fixture.service.authorize([active.email])).toThrow(/starting/);
    await fixture.service.initialize();
    fixture.cloudflare.failWrites = true;
    await expect(fixture.service.sweep()).rejects.toBeInstanceOf(VisitorAccessError);
    expect(() => fixture.service.authorize([expired.email])).toThrow(/active visitor invitation/);
    expect(() => fixture.service.authorize(["display-only"])).toThrow(/active visitor invitation/);
    expect(() =>
      fixture.service.authorize(["unknown@example.com", active.email]).assertCurrent(),
    ).not.toThrow();
  });

  it("ends access at the deadline while another serialized provider write is waiting", async () => {
    const grant = visitorGrant("visitor@example.com", { expiresAt: NOW + 1_000 });
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    await fixture.service.initialize();
    const authority = fixture.service.authorize([grant.email]);
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.cloudflare.beforeWrite = async () => {
      writing.resolve();
      await release.promise;
    };
    const pending = fixture.service.invite({ email: "other@example.com" }, fixture.authority);
    await writing.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(authority.signal.aborted).toBe(true);
    expect(() => authority.assertCurrent()).toThrow(/access ended/);
    expect(() => fixture.service.authorize(["other@example.com"])).toThrow(
      /active visitor invitation/,
    );
    release.resolve();
    await pending;
    expect(() => fixture.service.authorize(["other@example.com"]).assertCurrent()).not.toThrow();
  });

  it("renews an active lifetime but never revives a lifetime that already expired", async () => {
    const grant = visitorGrant("visitor@example.com");
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    await fixture.service.initialize();
    const original = fixture.service.authorize([grant.email]);
    await vi.advanceTimersByTimeAsync(DAY_MS / 2);
    await fixture.service.invite({ email: grant.email, days: 30 }, fixture.authority);
    await vi.advanceTimersByTimeAsync(DAY_MS / 2);
    expect(() => original.assertCurrent()).not.toThrow();
    await vi.advanceTimersByTimeAsync(29.5 * DAY_MS);
    expect(original.signal.aborted).toBe(true);
    await fixture.service.invite({ email: grant.email, days: 1 }, fixture.authority);
    expect(() => fixture.service.authorize([grant.email]).assertCurrent()).not.toThrow();
    expect(() => original.assertCurrent()).toThrow(/access ended/);
  });

  it("closes retained access before provider revocation settles and serializes a later renewal", async () => {
    const grant = visitorGrant("visitor@example.com");
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    await fixture.service.initialize();
    const authority = fixture.service.authorize([grant.email]);
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.cloudflare.beforeWrite = async () => {
      writing.resolve();
      await release.promise;
    };
    const revoking = fixture.service.revoke(
      { email: grant.email },
      fixture.authority.assertCurrent,
    );
    await writing.promise;
    const renewing = fixture.service.invite({ email: grant.email }, fixture.authority);
    expect(authority.signal.aborted).toBe(true);
    expect(() => fixture.service.authorize([grant.email])).toThrow(/active visitor invitation/);
    release.resolve();
    await Promise.all([revoking, renewing]);
    expect(() => fixture.service.authorize([grant.email]).assertCurrent()).not.toThrow();
    expect(() => authority.assertCurrent()).toThrow(/access ended/);
  });

  it("closes retained authority on service replacement without deleting saved grants", async () => {
    const grant = visitorGrant("visitor@example.com", { expiresAt: null });
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    await fixture.service.initialize();
    const authority = fixture.service.authorize([grant.email]);
    fixture.service.close();
    expect(authority.signal.aborted).toBe(true);
    expect(() => authority.assertCurrent()).toThrow(/stopping/);
    expect(fixture.grants.get(grant.email)).toEqual(grant);
  });

  it("does not start a durable revocation after closing during the grant read", async () => {
    const grant = visitorGrant("visitor@example.com");
    const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const read = fixture.store.entries.bind(fixture.store);
    fixture.store.entries = async () => {
      entered.resolve();
      await release.promise;
      return read();
    };
    const revoking = fixture.service.revoke(
      { email: grant.email },
      fixture.authority.assertCurrent,
    );
    await entered.promise;
    fixture.service.close();
    release.resolve();
    await expect(revoking).rejects.toThrow(/stopping/);
    expect(fixture.grants.get(grant.email)).toEqual(grant);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each(["rejected", "committed but response lost"] as const)(
    "preserves the prior grant and lifetime when renewal is %s",
    async (outcome) => {
      const grant = visitorGrant("visitor@example.com");
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      await fixture.service.initialize();
      const original = fixture.service.authorize([grant.email]);
      const recorded = structuredClone(fixture.grants.get(grant.email));
      // Dashboard drift makes this renewal require a provider write.
      fixture.cloudflare.policy = undefined;
      fixture.cloudflare.failWrites = outcome === "rejected";
      fixture.cloudflare.loseWriteResponse = outcome === "committed but response lost";

      await expect(
        fixture.service.invite({ email: grant.email, days: 2 }, fixture.authority),
      ).rejects.toBeInstanceOf(VisitorAccessError);

      expect(fixture.grants.get(grant.email)).toEqual(recorded);
      expect(() => original.assertCurrent()).not.toThrow();
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(original.signal.aborted).toBe(true);
      expect(() => fixture.service.authorize([grant.email])).toThrow(/active visitor invitation/);
    },
  );

  it.each(["invite", "renew"] as const)(
    "requires current authority to activate %s after a confirmed provider effect",
    async (operation) => {
      const email = "visitor@example.com";
      const previous = operation === "renew" ? visitorGrant(email) : undefined;
      const fixture = visitorFixture({ grants: previous ? [previous] : [] });
      let current = true;
      fixture.authority.assertCurrent.mockImplementation(() => {
        if (!current) {
          throw new Error("Invitation authority is no longer current");
        }
      });
      fixture.cloudflare.afterWrite = () => {
        current = false;
      };

      await expect(fixture.service.invite({ email, days: 2 }, fixture.authority)).rejects.toThrow(
        /no longer current/,
      );

      expect(fixture.emails()).toEqual([email]);
      expect(fixture.grants.get(email)).toEqual(
        previous ?? { email, createdAt: NOW, expiresAt: NOW },
      );
    },
  );
});
