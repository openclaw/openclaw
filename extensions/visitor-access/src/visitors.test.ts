import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisitorAccessError } from "./errors.js";
import {
  DAY_MS,
  NOW,
  closeVisitorFixtures,
  guestRole,
  requestUrl,
  staffRole,
  visitorFixture,
  visitorGrant,
  type GatewayRoles,
  type ProfileFixture,
} from "./visitors.test-support.js";

const EMAIL = "visitor@example.com";

describe("VisitorAccessService", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    closeVisitorFixtures();
    vi.useRealTimers();
  });

  it("invites the runtime-resolved numeric GitHub account and explains login", async () => {
    const fixture = visitorFixture({
      githubAccountId: 42,
      githubLogin: "Current-Visitor",
      profiles: [{ id: "unlinked-person", emails: [EMAIL], role: "staff" }],
      githubProfiles: [{ accountId: 84, profileId: "unlinked-person" }],
    });

    const result = await fixture.service.invite(
      { github: "Visitor" },
      { ...fixture.authority, invitedVia: "session:maintainer" },
    );

    expect(fixture.targets()).toEqual([42]);
    expect(fixture.emails()).toEqual([]);
    expect([...fixture.grants.keys()]).toEqual(["github:42"]);
    expect(fixture.grants.get("github:42")).toEqual({
      grantId: expect.any(String),
      githubAccountId: 42,
      githubLogin: "Current-Visitor",
      invitedVia: "session:maintainer",
      createdAt: NOW,
      expiresAt: NOW + 14 * DAY_MS,
    });
    expect(fixture.resolveGitHubAccount).toHaveBeenCalledWith({
      login: "visitor",
      signal: undefined,
    });
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin === "https://api.cloudflare.com",
      ),
    ).toBe(true);
    expect(result.text).toContain("@Current-Visitor");
    expect(result.text).toContain("GitHub account 42");
    expect(result.text).not.toContain(EMAIL);
    expect(result.details).toMatchObject({ githubAccountId: 42, githubLogin: "Current-Visitor" });
    expect(result.details).not.toHaveProperty("email");
    expect(result.text).toContain("2026-09-11T12:00:00.000Z");
    expect(result.text).toContain("https://team.openclaw.ai");
    expect(result.text).toContain("Team's existing login");
    expect(result.text).toContain("restricted guest");
    expect(result.text).toContain("first sign-in pending");
    expect(fixture.gatewayRequest).toHaveBeenCalledWith(
      "users.list",
      { githubAccountIds: [42] },
      { scopes: ["operator.read"] },
    );
  });

  const rateLimit =
    "GitHub rate limit reached while resolving visitor; retry after 2026-08-28T13:00:00.000Z.";
  it.each([
    [404, true, "GitHub login visitor was not found. Check the login and retry."],
    [400, true, "visitor is not a valid GitHub login. Check the login and retry."],
    [429, true, rateLimit],
    [
      429,
      false,
      `${rateLimit} Configure gateway.controlUi.github.token to increase the GitHub API quota.`,
    ],
    [502, true, "GitHub account lookup failed (GitHub request failed). Retry later."],
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
      await expect(fixture.invite({ github: "visitor" })).rejects.toMatchObject({
        message: expected,
      });
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.grants.size).toBe(0);
    },
  );

  it.each<{ reason: string; roles?: GatewayRoles; lookupFails?: boolean }>([
    { reason: "the Gateway access lookup fails", lookupFails: true },
    { reason: "roles are disabled" },
    { reason: "no default is configured", roles: { definitions: { guest: guestRole } } },
    {
      reason: "the default role is unknown",
      roles: { default: "missing", definitions: { guest: guestRole } },
    },
    ...(
      [
        ["the Visitor Access policy is not required", { accessPolicyPlugin: undefined }],
        ["a different access policy is required", { accessPolicyPlugin: "unrelated-policy" }],
        ["sandboxing is inherited", { sandbox: "inherit" }],
        ["model access is unrestricted", { modelPolicy: undefined }],
        ["other sessions are writable", { sessions: { others: "write" } }],
        ["no agent is permitted", { agents: [] }],
        [
          "shared operator actions are allowed",
          { scopes: [...guestRole.scopes, "operator.admin"] },
        ],
        ["own-session work is unavailable", { scopes: [] }],
      ] satisfies [string, Partial<typeof guestRole>][]
    ).map(([reason, overrides]) => ({
      reason,
      roles: { default: "guest", definitions: { guest: { ...guestRole, ...overrides } } },
    })),
  ])("refuses new invitations when $reason", async ({ roles, lookupFails }) => {
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

  it.each<
    [
      name: string,
      profile: Partial<ProfileFixture>,
      access: string,
      otherRole?: typeof staffRole,
      github?: boolean,
    ]
  >([
    [
      "the explicitly assigned default role",
      { role: "guest" },
      'restricted guest (assigned role "guest")',
    ],
    [
      "an independent role with guest-shaped permissions",
      { role: "staff" },
      'existing role "staff" retained; this invitation does not restrict it',
      { ...guestRole, accessPolicyPlugin: undefined },
    ],
    [
      "the default after an assigned role was removed",
      { role: "retired" },
      'restricted guest (default role "guest"; unavailable assignment "retired")',
    ],
    [
      "the shared Gateway owner with a historical email alias",
      { id: "gateway-owner" },
      "shared owner authority retained; this invitation does not restrict it",
    ],
    [
      "the declarative GitHub role without an explicit assignment",
      { effectiveRole: "staff", roleSource: "githubLogin" },
      'existing role "staff" retained; this invitation does not restrict it',
      staffRole,
      true,
    ],
  ])(
    "reports %s through the canonical invitation target",
    async (_name, profile, access, otherRole = staffRole, github = false) => {
      const profileId = profile.id ?? "linked-person";
      const fixture = visitorFixture({
        profiles: [
          { id: profileId, emails: ["primary@example.com", "alias@example.com"], ...profile },
        ],
        githubProfiles: github ? [{ accountId: 42, profileId }] : [],
        gatewayConfig: {
          gateway: {
            roles: { default: "guest", definitions: { guest: guestRole, staff: otherRole } },
          },
        },
      });

      const result = await fixture.service.invite(
        github ? { github: "Visitor", days: 1 } : { email: " Alias@Example.com ", days: 1 },
        fixture.authority,
      );

      expect(result.text).toContain(access);
      expect(result.text).toContain("Visitor grant expires: 2026-08-29T12:00:00.000Z");
      expect(fixture.targets()).toEqual([github ? 42 : "alias@example.com"]);
      expect(fixture.grants.get(github ? "github:42" : "alias@example.com")).toMatchObject({
        ...(github
          ? { githubAccountId: 42, githubLogin: "visitor" }
          : { email: "alias@example.com" }),
        expiresAt: NOW + DAY_MS,
      });
      expect(fixture.resolveGitHubAccount).toHaveBeenCalledTimes(github ? 1 : 0);
      vi.setSystemTime(NOW + DAY_MS);
      const list = await fixture.list();
      expect(list.text).toContain(
        "grant expires 2026-08-29T12:00:00.000Z | EXPIRED; provider cleanup pending",
      );
      expect(list.text).toContain(access);
      expect(list.details.grants).toEqual([
        expect.objectContaining({
          ...(github ? { githubAccountId: 42 } : { email: "alias@example.com" }),
          state: "expired",
        }),
      ]);
      expect(list.details.grants[0]).not.toHaveProperty("githubLogin");
      expect(fixture.gatewayRequest.mock.calls.every(([method]) => method === "users.list")).toBe(
        true,
      );
    },
  );

  it.each(["invite", "revoke"] as const)(
    "refuses %s on a legacy store before reading grants or calling a provider",
    async (operation) => {
      const grant = visitorGrant(EMAIL, { githubLogin: "visitor" });
      const fixture = visitorFixture({ grants: [grant], emails: [grant.email] });
      delete fixture.store.withCurrent;
      const lookup = vi.spyOn(fixture.store, "lookup");
      const entries = vi.spyOn(fixture.store, "entries");

      await expect(
        operation === "invite"
          ? fixture.invite({ github: "visitor" })
          : fixture.revoke({ github: "visitor" }),
      ).rejects.toThrow(/Update OpenClaw before managing visitors/);

      expect(lookup).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.gatewayRequest).not.toHaveBeenCalled();
      expect(fixture.grants.get(grant.email)).toEqual(grant);
      expect(fixture.emails()).toEqual([grant.email]);
    },
  );

  it("checks live authority after recording cleanup before granting provider access", async () => {
    const fixture = visitorFixture();
    const recorded = createDeferred<void>();
    const release = createDeferred<void>();
    let current = true;
    fixture.authority.assertCurrent.mockImplementation(() => {
      if (!current) {
        throw new Error("Invitation authority is no longer current");
      }
    });
    const register = fixture.store.register.bind(fixture.store);
    vi.spyOn(fixture.store, "register").mockImplementationOnce(async (key, grant) => {
      await register(key, grant);
      recorded.resolve();
      await release.promise;
    });
    const invitation = fixture.invite({ email: EMAIL });
    const denied = expect(invitation).rejects.toThrow(/no longer current/);
    await recorded.promise;
    current = false;
    release.resolve();

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
      let current = true;
      fixture.authority.assertCurrent.mockImplementation(() => {
        if (!current) {
          throw new Error("Visitor authority is no longer current");
        }
      });
      if (operation !== "revoke") {
        const register = fixture.store.register.bind(fixture.store);
        vi.spyOn(fixture.store, "register").mockImplementation(async (key, grant) => {
          await register(key, grant);
          if (grant.expiresAt !== null && grant.expiresAt > NOW) {
            current = false;
          }
        });
      } else {
        const remove = fixture.store.delete.bind(fixture.store);
        vi.spyOn(fixture.store, "delete").mockImplementationOnce(async (key) => {
          const removed = await remove(key);
          current = false;
          return removed;
        });
      }

      const result =
        operation === "revoke"
          ? fixture.revoke({ email: previous.email })
          : fixture.invite({ email: previous.email, days: 2 });
      await expect(result).resolves.toMatchObject({
        text: expect.stringContaining(
          operation === "invite" ? "Invited" : operation === "renew" ? "Renewed" : "Revoked",
        ),
      });

      expect(current).toBe(false);
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
    { operation: "revoke", input: {} },
  ])(
    "rejects invalid $operation input before provider or grant effects: $input",
    async ({ operation, input }) => {
      const grant = visitorGrant(EMAIL);
      const fixture = visitorFixture(
        operation === "revoke" ? { grants: [grant], emails: [grant.email] } : {},
      );
      await expect(
        operation === "invite" ? fixture.invite(input) : fixture.revoke(input),
      ).rejects.toBeInstanceOf(VisitorAccessError);
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
      expect(fixture.resolveGitHubAccount).toHaveBeenCalledTimes(1);
      const list = await fixture.list();
      expect(list.details.grants).toHaveLength(1);
      expect(list.details.grants[0]).not.toHaveProperty("githubLogin");
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
    const profiles = [
      {
        id: "old-person",
        mergedInto: "person",
        emails: [grant.email],
        githubIdentity: { login: "visitor" },
      },
    ];
    fixture.setProfiles(profiles);

    await expect(fixture.revoke({ github: "visitor" })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [], githubAccountIds: [42], githubLogin: "visitor" },
    });
    expect([...fixture.grants.values()]).toEqual([grant]);
    expect(fixture.targets()).toEqual([grant.email]);

    fixture.fetcher.mockClear();
    fixture.gatewayRequest.mockClear();
    fixture.gatewayRequest.mockRejectedValue(new Error("Profile directory unavailable"));
    await expect(fixture.revoke({ email: grant.email, github: "visitor" })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [grant.email] },
    });
    expect(fixture.emails()).toEqual([]);
    expect(fixture.gatewayRequest).not.toHaveBeenCalled();
    expect(
      fixture.fetcher.mock.calls.every(
        ([url]) => requestUrl(url).origin === "https://api.cloudflare.com",
      ),
    ).toBe(true);
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
      expect(fixture.mutations()).toEqual([]);
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.resolveGitHubAccount).toHaveBeenCalledWith({
        login: "visitor",
        signal: undefined,
      });
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
    expect(result.text).toContain("2 unmanaged, 1 missing from policy");
    expect(result.text).toMatch(
      /d-missing@example.com.*Verified GitHub: unavailable.*2026-08-27T12:00:00.000Z.*2026-08-29T12:00:00.000Z.*MISSING FROM POLICY/,
    );
    expect(result.text).toMatch(/e-manual@example.com.*UNMANAGED/);
    expect(result.text.match(/UNMANAGED/g)).toHaveLength(1);
    expect(result.text).toContain("1 entries omitted");
    expect(result.details.grants.length + result.details.unmanaged.length).toBe(
      result.text.split("\n").length - 2,
    );
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
    const writing = createDeferred<void>();
    const release = createDeferred<void>();
    fixture.cloudflare.beforeWrite = async () => {
      writing.resolve();
      await release.promise;
    };
    const first = fixture.invite({ email: "first@example.com" });
    await writing.promise;
    const second = fixture.invite({ email: "second@example.com" });
    release.resolve();

    await Promise.all([first, second]);

    expect(fixture.emails()).toEqual(["first@example.com", "second@example.com"]);
    expect([...fixture.grants.keys()]).toEqual(["first@example.com", "second@example.com"]);
  });
});
