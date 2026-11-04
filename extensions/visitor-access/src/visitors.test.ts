import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { VisitorAccessError } from "./errors.js";
import { grantIdSchema } from "./visitor-input.js";
import {
  DAY_MS,
  NOW,
  useVisitorFixtures,
  visitorGate,
  guestRole,
  staffRole,
  visitorFixture,
  visitorGrant,
  type GatewayRoles,
  type ProfileFixture,
} from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";
const guestRoles = (overrides: Partial<typeof guestRole> = {}): GatewayRoles => ({
  default: "guest",
  definitions: { guest: { ...guestRole, ...overrides } },
});
const retainedStaff = 'existing role "staff" retained; this invitation does not restrict it';

describe("VisitorAccessService", () => {
  useVisitorFixtures();

  it("validates only the selected invitation and keeps its snapshot detached", async () => {
    const grants = Array.from({ length: 500 }, (_, i) => visitorGrant(`${i}@example.com`));
    const fixture = visitorFixture({ grants });
    await fixture.service.initialize();
    const selected = grants.at(-1)!;
    const validate = vi.spyOn(grantIdSchema, "safeParse");
    try {
      const invitation = fixture.service.findActiveInvitation(selected.grantId!);
      expect(invitation).toEqual(selected);
      expect(validate).toHaveBeenCalledTimes(1);
      invitation!.expiresAt = null;
      vi.setSystemTime(NOW + DAY_MS);
      expect(fixture.service.findActiveInvitation(selected.grantId!)).toBeUndefined();
    } finally {
      validate.mockRestore();
    }
  });

  it("invites the runtime-resolved numeric GitHub account and explains login", async () => {
    const fixture = visitorFixture({
      githubLogin: "Current-Visitor",
      profiles: [{ id: "unlinked-person", emails: [EMAIL], role: "staff" }],
      githubProfiles: [{ accountId: 84, profileId: "unlinked-person" }],
    });

    const result = await fixture.service.invite(
      { github: "Visitor" },
      {
        ...fixture.authority,
        signInUrl: "https://team.openclaw.ai",
      },
    );

    expect(fixture.targets()).toEqual([42]);
    expect(fixture.grants.get("github:42")).toMatchObject({
      githubAccountId: 42,
      githubLogin: "Current-Visitor",
      expiresAt: NOW + 14 * DAY_MS,
    });
    expect(result.text).toMatch(
      /@Current-Visitor.*GitHub account 42.*2026-09-11T12:00:00\.000Z.*restricted guest.*first sign-in pending.*https:\/\/team\.openclaw\.ai.*Team's existing login/,
    );
    expect(result.text).not.toContain(EMAIL);
    expect(result.details).not.toHaveProperty("email");
  });

  it.each([
    [404, true, /visitor was not found.*retry/],
    [400, true, /visitor is not a valid GitHub login.*retry/],
    [429, true, /rate limit.*2026-08-28T13:00:00.000Z/],
    [429, false, /2026-08-28T13:00:00.000Z.*Configure gateway.controlUi.github.token/],
    [502, true, /lookup failed.*GitHub request failed.*Retry later/],
  ] as const)(
    "reports GitHub status %s with credential=%s",
    async (statusCode, credentialConfigured, expected) => {
      const fixture = visitorFixture();
      fixture.resolveGitHubAccount.mockResolvedValue({
        error: {
          statusCode,
          credentialConfigured,
          message: "GitHub request failed",
          retryAtMs: NOW + 3_600_000,
        },
      });
      await expect(fixture.invite({ github: "visitor" })).rejects.toThrow(expected);
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.grants.size).toBe(0);
    },
  );

  it.each<[string, GatewayRoles?, boolean?]>([
    ["profile lookup fails", undefined, true],
    ["roles are disabled"],
    ["default is absent", { definitions: { guest: guestRole } }],
    ["default is unknown", { ...guestRoles(), default: "missing" }],
    ["policy is absent", guestRoles({ accessPolicyPlugin: undefined })],
    ["policy is unrelated", guestRoles({ accessPolicyPlugin: "unrelated-policy" })],
    ["sandbox is inherited", guestRoles({ sandbox: "inherit" })],
    ["models are unrestricted", guestRoles({ modelPolicy: undefined })],
    ["shared sessions are writable", guestRoles({ sessions: { others: "write" } })],
    ["no agent is allowed", guestRoles({ agents: [] })],
    ["admin scope is allowed", guestRoles({ scopes: [...guestRole.scopes, "operator.admin"] })],
    ["own-session work is unavailable", guestRoles({ scopes: [] })],
  ])("refuses invitations when %s", async (_reason, roles, lookupFails) => {
    const fixture = visitorFixture(
      lookupFails ? {} : { gatewayConfig: roles ? { gateway: { roles } } : {} },
    );
    if (lookupFails) {
      fixture.gatewayRequest.mockRejectedValueOnce(new Error("Profile directory unavailable"));
    }

    await expect(fixture.invite({ email: EMAIL })).rejects.toThrow(
      lookupFails ? "Profile directory unavailable" : /requires gateway\.roles\.default/,
    );

    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);
  });

  it.each<[string, Partial<ProfileFixture>, string, typeof staffRole?]>([
    ["assigned guest", { role: "guest" }, 'restricted guest (assigned role "guest")'],
    [
      "independent guest-shaped role",
      { role: "staff" },
      retainedStaff,
      { ...guestRole, accessPolicyPlugin: undefined },
    ],
    [
      "removed assignment",
      { role: "retired" },
      'restricted guest (default role "guest"; unavailable assignment "retired")',
    ],
    [
      "shared owner alias",
      { id: "gateway-owner" },
      "shared owner authority retained; this invitation does not restrict it",
    ],
    [
      "declarative GitHub role",
      { role: "guest", effectiveRole: "staff", roleSource: "githubLogin" },
      retainedStaff,
    ],
  ])(
    "reports %s through the canonical invitation target",
    async (_name, profile, access, otherRole = staffRole) => {
      const profileId = profile.id ?? "linked-person";
      const fixture = visitorFixture({
        profiles: [
          { id: profileId, emails: ["primary@example.com", "alias@example.com"], ...profile },
        ],
        gatewayConfig: {
          gateway: {
            roles: { default: "guest", definitions: { guest: guestRole, staff: otherRole } },
          },
        },
      });

      const result = await fixture.invite({ email: " Alias@Example.com ", days: 1 });

      expect(result.text).toContain(access);
      vi.setSystemTime(NOW + DAY_MS);
      const list = await fixture.list();
      expect(list.text).toContain(access);
    },
  );

  it.each(["invite", "revoke"] as const)(
    "refuses %s on a legacy store without provider or grant effects",
    async (operation) => {
      const grant = visitorGrant(EMAIL, { githubLogin: "visitor" });
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      delete fixture.store.withCurrent;
      const run = operation === "invite" ? fixture.invite : fixture.revoke;
      await expect(run({ github: "visitor" })).rejects.toThrow(
        /Update OpenClaw before managing visitors/,
      );

      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.gatewayRequest).not.toHaveBeenCalled();
      expect(fixture.grants.get(grant.email)).toEqual(grant);
      expect(fixture.emails()).toEqual([grant.email]);
    },
  );

  it("checks live authority after recording cleanup before granting provider access", async () => {
    const fixture = visitorFixture();
    const gate = visitorGate();

    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (key, grant) => {
      await register(key, grant);
      await gate.wait();
    });
    const invitation = fixture.invite({ email: EMAIL });
    const denied = expect(invitation).rejects.toThrow(/no longer current/);
    await gate.entered;
    fixture.revokeAuthority();
    gate.release();

    await denied;

    expect(fixture.emails()).toEqual([]);
    expect(fixture.mutations()).toEqual([]);
    expect(fixture.grants.get(EMAIL)?.expiresAt).toBe(NOW);
  });

  it.each(["invite", "renew", "revoke"] as const)(
    "settles a successful %s when authority closes after its final effect",
    async (operation) => {
      const previous = visitorGrant(EMAIL);
      const fixture = visitorFixture(
        operation === "invite" ? {} : { grants: [previous], emails: [previous.email] },
      );

      const register = fixture.store.register.bind(fixture.store);
      vi.spyOn(fixture.store, "register").mockImplementation(async (key, grant) => {
        await register(key, grant);
        if (grant.expiresAt !== null && grant.expiresAt > NOW) {
          fixture.revokeAuthority();
        }
      });
      const remove = fixture.store.delete.bind(fixture.store);
      vi.spyOn(fixture.store, "delete").mockImplementationOnce(async (key) => {
        const removed = await remove(key);
        fixture.revokeAuthority();
        return removed;
      });

      const result =
        operation === "revoke"
          ? fixture.revoke({ email: previous.email })
          : fixture.invite({ email: previous.email, days: 2 });
      expect((await result).details.outcome).toBe(
        operation === "invite" ? "invited" : operation === "renew" ? "renewed" : "revoked",
      );

      expect(fixture.authority.assertCurrent).toThrow(/no longer current/);
      if (operation === "revoke") {
        expect(fixture.grants.size).toBe(0);
        expect(fixture.emails()).toEqual([]);
      } else {
        expect(fixture.grants.get(previous.email)).toMatchObject({
          createdAt: operation === "invite" ? NOW : previous.createdAt,
          expiresAt: NOW + 2 * DAY_MS,
        });
        expect(fixture.emails()).toEqual([previous.email]);
      }
      if (operation === "renew") {
        expect(fixture.mutations()).toEqual([]);
      }
    },
  );

  it.each([
    { operation: "invite", input: {} },
    { operation: "invite", input: { email: "a@example.com\nBcc:other@example.com" } },
    { operation: "invite", input: { email: EMAIL, github: "visitor" } },
    { operation: "invite", input: { email: EMAIL, days: 0 } },
    { operation: "invite", input: { email: EMAIL, note: "x".repeat(1001) } },
    { operation: "invite", input: { email: EMAIL, note: 7 } },
    { operation: "invite", input: { email: EMAIL, invitedBy: { profileId: "untrusted" } } },
    { operation: "revoke", input: {} },
  ])(
    "rejects invalid $operation input before provider or grant effects: $input",
    async ({ operation, input }) => {
      const grant = visitorGrant(EMAIL);
      const fixture = visitorFixture(
        operation === "revoke" ? { grants: [grant], emails: [grant.email] } : {},
      );
      const run = operation === "invite" ? fixture.invite : fixture.revoke;
      await expect(run(input)).rejects.toThrow(
        "note" in input ? /note must be a string of at most 1000 characters/ : VisitorAccessError,
      );
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect([...fixture.grants.values()]).toEqual(operation === "revoke" ? [grant] : []);
      expect(fixture.emails()).toEqual(operation === "revoke" ? [grant.email] : []);
    },
  );

  it("requires explicit forever when no default duration is configured", async () => {
    const fixture = visitorFixture({ config: { defaultTtlDays: null } });
    await expect(fixture.invite({ email: EMAIL })).rejects.toThrow(/forever/);
    expect(fixture.grants.size).toBe(0);
    expect(fixture.mutations()).toEqual([]);

    const result = await fixture.invite({ email: EMAIL, forever: true });
    expect(fixture.grants.get(EMAIL)?.expiresAt).toBeNull();
    expect(result.text).toContain("never");
    await expect(fixture.invite({ email: EMAIL, forever: true, days: 1 })).rejects.toThrow(
      /days.*forever/,
    );
  });

  it("counts managed and unmanaged grants toward admission while allowing an existing grant to renew", async () => {
    const previous = visitorGrant(EMAIL, { githubLogin: "visitor" });
    const fixture = visitorFixture({
      config: { maxVisitors: 2 },
      grants: [previous],
      emails: [previous.email, "manual@example.com"],
    });
    await expect(fixture.invite({ email: "third@example.com" })).rejects.toThrow(/limit/);
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);

    vi.setSystemTime(NOW + DAY_MS);
    const renewed = await fixture.invite({ email: "VISITOR@example.com", days: 4 });
    expect(fixture.grants.get(previous.email)).toMatchObject({
      createdAt: previous.createdAt,
      githubLogin: "visitor",
      expiresAt: NOW + 5 * DAY_MS,
    });
    expect(fixture.emails()).toEqual([previous.email, "manual@example.com"]);
    expect(fixture.grants.size).toBe(1);
    expect(renewed.text).toContain("Renewed");
    expect(renewed.text).toContain("restricted guest");

    fixture.gatewayRequest.mockResolvedValueOnce({
      profiles: [{ id: "promoted-person", emails: [previous.email], role: "staff" }],
    });
    const promoted = await fixture.invite({ email: previous.email, days: 7 });
    expect(promoted.text).toContain('existing role "staff" retained');
    expect(fixture.grants.get(previous.email)).toMatchObject({
      createdAt: previous.createdAt,
      expiresAt: NOW + 8 * DAY_MS,
    });
    expect(fixture.mutations()).toEqual([]);
  });

  it.each([undefined, "github.com"])(
    "revokes only the public account and its grants across a login collision (host=%s)",
    async (host) => {
      const grants = ["first@example.com", "second@example.com"].map((email) =>
        visitorGrant(email, { githubLogin: "old-label" }),
      );
      const account = visitorGrant(42, { githubLogin: "old-label" });
      const unrelated = visitorGrant("other@example.com", { githubLogin: "visitor" });
      const fixture = visitorFixture({
        grants: [...grants, account, unrelated],
        emails: [...grants.map((grant) => grant.email), unrelated.email, "manual@example.com"],
        githubAccountIds: [42],
        githubProfiles: [{ accountId: 42, profileId: "person" }],
      });
      fixture.setProfiles([
        {
          id: "person",
          emails: [...grants.map((grant) => grant.email), "manual@example.com"],
          githubIdentity: { ...(host ? { host } : {}), login: "Visitor" },
        },
        {
          id: "enterprise-person",
          emails: [unrelated.email],
          githubIdentity: { host: "ghe.example.test", login: "Visitor" },
        },
      ]);

      const result = await fixture.revoke({ github: "Visitor" });

      expect(fixture.targets()).toEqual([unrelated.email, "manual@example.com"]);
      expect([...fixture.grants.values()]).toEqual([unrelated]);
      expect(result.text).toContain("@visitor (GitHub account 42)");
      expect(result.details).toMatchObject({
        emails: grants.map((grant) => grant.email),
        githubAccountIds: [42],
      });
    },
  );

  it("revokes only the pending numeric grant when its profile was merged", async () => {
    const grant = visitorGrant(EMAIL, { githubLogin: "visitor" });
    const pending = visitorGrant(42, { githubLogin: "old-login" });
    const fixture = visitorFixture({
      grants: [grant, pending],
      emails: [grant.email],
      githubAccountIds: [42],
      githubProfiles: [{ accountId: 42, profileId: "old-person" }],
    });
    fixture.setProfiles([
      {
        id: "old-person",
        mergedInto: "person",
        emails: [grant.email],
        githubIdentity: { login: "visitor" },
      },
    ]);

    await expect(fixture.revoke({ github: "visitor" })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [], githubAccountIds: [42], githubLogin: "visitor" },
    });
    expect([...fixture.grants.values()]).toEqual([grant]);
    expect(fixture.targets()).toEqual([grant.email]);

    fixture.gatewayRequest.mockClear();
    fixture.gatewayRequest.mockRejectedValue(new Error("Profile directory unavailable"));
    await expect(fixture.revoke({ email: grant.email, github: "visitor" })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [grant.email] },
    });
    expect(fixture.emails()).toEqual([]);
    expect(fixture.gatewayRequest).not.toHaveBeenCalled();
  });

  it.each(["conflicting", "reassigned"] as const)(
    "rejects a %s verified GitHub label before changing grants or policy",
    async (scenario) => {
      const grant = visitorGrant(EMAIL, { githubLogin: "visitor" });
      const account = visitorGrant(42, { githubLogin: "old-login" });
      const fixture = visitorFixture({
        grants: [grant, account],
        emails: [grant.email],
        githubAccountIds: [42],
        githubProfiles: [
          { accountId: 42, profileId: scenario === "conflicting" ? "person" : "other-person" },
        ],
      });
      fixture.setProfiles([
        { id: "person", emails: [grant.email], githubIdentity: { login: "visitor" } },
        {
          id: "other-person",
          emails: ["other@example.com"],
          githubIdentity: { login: scenario === "conflicting" ? "Visitor" : "other-person" },
        },
      ]);

      await expect(fixture.revoke({ github: "visitor" })).rejects.toThrow(
        /profileId.*grantId.*email/,
      );

      expect([...fixture.grants.values()]).toEqual([grant, account]);
      expect(fixture.targets()).toEqual([grant.email, 42]);
      expect(fixture.fetcher).not.toHaveBeenCalled();
    },
  );

  it("explicitly revokes unmanaged emails and makes a repeated revoke a clean no-op", async () => {
    const fixture = visitorFixture({ emails: ["manual@example.com"] });
    await expect(fixture.revoke({ email: "manual@example.com" })).resolves.toMatchObject({
      text: expect.stringContaining("Revoked"),
    });
    expect(fixture.emails()).toEqual([]);
    expect(fixture.cloudflare.policy).toBeUndefined();
    expect(fixture.grants.size).toBe(0);
    const writes = fixture.mutations().length;

    await expect(fixture.revoke({ email: "manual@example.com" })).resolves.toMatchObject({
      text: expect.stringMatching(/nothing to revoke/),
    });
    expect(fixture.mutations()).toHaveLength(writes);
  });

  it("lists bounded dashboard drift and sweeps only expired managed access", async () => {
    const expired = visitorGrant("a-expired@example.com", { expiresAt: NOW });
    const active = visitorGrant("b-active@example.com");
    const forever = visitorGrant("c-forever@example.com", { expiresAt: null });
    const missing = visitorGrant("d-missing@example.com", { githubLogin: "visitor" });
    const manual = ["e-manual@example.com", "f-manual@example.com"];
    const fixture = visitorFixture({
      config: { maxVisitors: 5 },
      grants: [expired, active, forever, missing],
      emails: [expired.email, active.email, forever.email, ...manual],
    });
    const result = await fixture.list();
    expect(result.details).toMatchObject({
      counts: { recorded: 4, inPolicy: 5, unmanaged: 2, missingFromPolicy: 1 },
      grants: [
        { email: expired.email, state: "expired" },
        { email: active.email, state: "managed" },
        { email: forever.email, state: "managed", expiresAt: null },
        { email: missing.email, state: "missing_from_policy" },
      ],
      unmanaged: [{ email: manual[0] }],
      omitted: 1,
    });
    expect(result.text).toMatch(
      /d-missing@example.com.*Verified GitHub: unavailable.*2026-08-27T12:00:00.000Z.*2026-08-29T12:00:00.000Z.*MISSING FROM POLICY/,
    );
    expect(result.text).toMatch(/e-manual@example.com.*UNMANAGED/);
    expect(result.text).toContain("1 entries omitted");
    expect(result.text).toContain("EXPIRED; provider cleanup pending");
    expect(fixture.emails()).toHaveLength(5);
    expect(fixture.mutations()).toEqual([]);

    await fixture.service.sweep();
    expect(fixture.emails()).toEqual([active.email, forever.email, ...manual]);
    expect([...fixture.grants.values()]).toEqual([active, forever, missing]);
    expect(fixture.logger.info).toHaveBeenCalledWith(expect.stringContaining(expired.email));
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/unmanaged.*e-manual@example.com.*retained/),
    );
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/d-missing@example.com.*missing from policy/),
    );
  });

  it("serializes concurrent invites so a delayed policy write cannot lose another visitor", async () => {
    const fixture = visitorFixture();
    const gate = visitorGate();
    fixture.cloudflare.beforeWrite = gate.wait;
    const first = fixture.invite({ email: "first@example.com" });
    await gate.entered;
    const second = fixture.invite({ email: "second@example.com" });
    gate.release();

    await Promise.all([first, second]);

    expect(fixture.emails()).toEqual(["first@example.com", "second@example.com"]);
    expect([...fixture.grants.keys()]).toEqual(["first@example.com", "second@example.com"]);
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
    expect(fixture.grants.get("github:42")).not.toHaveProperty("onboarding");
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
    const expired = [...restarted.grants.values()];
    expect(
      await restarted.service.compareAndSetOnboarding({
        grantId,
        expected: null,
        next: { state: "pending" },
      }),
    ).toEqual({ applied: false, reason: "inactive" });
    expect(restarted.service.findActiveInvitation(grantId)).toBeUndefined();
    expect([...restarted.grants.values()]).toEqual(expired);

    await restarted.invite({ github: "renamed-login", days: 1 });
    const replacement = restarted.authorize([], [42]);
    expect(replacement.grantId).not.toBe(grantId);
    expect(restarted.service.findActiveInvitation(replacement.grantId!)).toMatchObject({
      onboarding: { state: "pending", updatedAt: NOW + 30.5 * DAY_MS },
    });
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
      // Dashboard drift makes this renewal require a provider write.
      fixture.cloudflare.policy = undefined;
      fixture.cloudflare.failWrites = outcome === "rejected";
      fixture.cloudflare.loseWriteResponse = outcome === "committed but response lost";

      await expect(fixture.invite({ email: grant.email, days: 2 })).rejects.toThrow(
        VisitorAccessError,
      );

      expect(fixture.grants.get(grant.email)).toEqual(grant);
      expect(() => original.assertCurrent()).not.toThrow();
      await vi.advanceTimersByTimeAsync(DAY_MS);
      expect(original.signal.aborted).toBe(true);
      expect(() => fixture.authorize([grant.email])).toThrow(/active visitor invitation/);
    },
  );

  it.each(["invite", "renew"] as const)(
    "requires current authority to activate %s after a confirmed provider effect",
    async (operation) => {
      const previous = operation === "renew" ? visitorGrant(EMAIL) : undefined;
      const fixture = visitorFixture({ grants: previous ? [previous] : [] });

      fixture.cloudflare.afterWrite = fixture.revokeAuthority;

      await expect(fixture.invite({ email: EMAIL, days: 2 })).rejects.toThrow(/no longer current/);

      expect(fixture.emails()).toEqual([EMAIL]);
      expect(fixture.grants.get(EMAIL)).toEqual(
        previous ?? {
          email: EMAIL,
          onboarding: { state: "pending", updatedAt: NOW },
          createdAt: NOW,
          expiresAt: NOW,
        },
      );
    },
  );
});
