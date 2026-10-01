import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { VisitorGrant } from "./src/visitors.js";
import { visitorProfileFixture } from "./src/visitors.test-support.js";

type PluginGatewayAccessPolicy = Parameters<OpenClawPluginApi["registerGatewayAccessPolicy"]>[0];

const TOKEN = "visitor-test-token-never-echo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const policiesUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const gatewayConfig: OpenClawConfig = {
  gateway: {
    roles: {
      default: "external-work",
      definitions: {
        "external-work": {
          accessPolicyPlugin: "visitor-access",
          sessions: { others: "view" },
          agents: ["main"],
          scopes: ["operator.sessions.write"],
          sandbox: "required",
          modelPolicy: {},
        },
        staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
      },
    },
  },
};

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function createPolicyFetch(initialEmails: string[] = []) {
  let emails = [...initialEmails];
  const controls = { failWrites: false, loseWriteResponse: false };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    if (!url.href.startsWith(policiesUrl)) {
      throw new Error(`Unexpected test request: ${url}`);
    }
    const policy = {
      id: "visitor-policy",
      name: "Visitors (openclaw-managed)",
      decision: "allow",
      include: emails.map((email) => ({ email: { email } })),
    };
    if (init?.method === "GET") {
      const result = url.search ? (emails.length ? [policy] : []) : policy;
      return Response.json({ success: true, result });
    }
    if (controls.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (init?.method === "DELETE") {
      emails = [];
    } else {
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON policy body");
      }
      const body = JSON.parse(init.body) as {
        include: Array<{ email: { email: string } }>;
      };
      emails = body.include.map((rule) => rule.email.email);
    }
    if (controls.loseWriteResponse) {
      throw new Error(`Transport failure with Authorization: Bearer ${TOKEN}`);
    }
    return Response.json({ success: true, result: {} });
  });
  return { fetcher, emails: () => emails, controls };
}

describe("visitor-access plugin lifecycle", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(() => {
    resetPluginStateStoreForTests();
    stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "visitor-access-test-")));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    vi.useFakeTimers({
      toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(START_MS);
  });

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function registerPlugin(
    contextOverrides: Partial<OpenClawPluginToolContext<2>> = {},
    config: OpenClawConfig = gatewayConfig,
  ) {
    const tools = new Map<string, AnyAgentTool>();
    const services: OpenClawPluginService[] = [];
    const accessPolicies: PluginGatewayAccessPolicy[] = [];
    const on = vi.fn<OpenClawPluginApi["on"]>();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const toolContext: OpenClawPluginToolContext<2> = {
      sessionKey: "agent:main:maintainer",
      senderIsOwner: true,
      assertInvocationCurrent() {},
      ...contextOverrides,
    };
    const api = createTestPluginApi({
      id: "visitor-access",
      pluginConfig: { accountId: "test-account", appId: "test-app", apiToken: TOKEN },
      logger,
      on,
      registerService: (service) => services.push(service),
      registerGatewayAccessPolicy: (policy) => accessPolicies.push(policy),
      registerTool: (registration) => {
        const resolved =
          typeof registration === "function"
            ? registration(toolContext)
            : "contextVersion" in registration
              ? registration.create(toolContext)
              : registration;
        for (const tool of Array.isArray(resolved) ? resolved : resolved ? [resolved] : []) {
          tools.set(tool.name, tool);
        }
      },
    });
    api.runtime.state = {
      ...api.runtime.state,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("visitor-access", { ...options, env }),
    };
    const directory = visitorProfileFixture();
    api.runtime.gateway = directory.gateway;
    const gatewayRequest = directory.request;
    api.runtime.config = {
      current: () => config,
      async mutateConfigFile() {
        throw new Error("Visitor operations must not change Gateway configuration");
      },
      async replaceConfigFile() {
        throw new Error("Visitor operations must not replace Gateway configuration");
      },
    };
    plugin.register(api);
    const service = services[0];
    if (!service) {
      throw new Error("Plugin did not register its expiry service");
    }
    const accessPolicy = accessPolicies[0];
    if (!accessPolicy) {
      throw new Error("Plugin did not register its Gateway access policy");
    }
    const context: OpenClawPluginServiceContext = { config: {}, stateDir, logger };
    cleanups.push(() => service.stop?.(context));
    const store = createPluginStateKeyedStoreForTests<VisitorGrant>("visitor-access", {
      namespace: "visitor-grants",
      maxEntries: 500,
      overflowPolicy: "reject-new",
      env,
    });
    return {
      tools,
      gatewayRequest,
      setProfiles: directory.setProfiles,
      logger,
      store,
      authorize: (
        profile: Parameters<PluginGatewayAccessPolicy["authorize"]>[0]["profile"],
        requiredByRole = true,
      ) => accessPolicy.authorize({ config, profile, requiredByRole }),
      toolContext,
      start: () => service.start(context),
      stop: () => service.stop?.(context),
      gatewayStart: () => {
        const hook = on.mock.calls.find(([name]) => name === "gateway_start")?.[1];
        if (!hook) {
          throw new Error("Plugin did not register its Gateway startup sweep");
        }
        const startHook = hook as (
          event: { port: number },
          context: { port?: number },
        ) => void | Promise<void>;
        return startHook({ port: 18789 }, {});
      },
      execute: (name: string, input: Record<string, unknown> = {}) => {
        const tool = tools.get(name);
        if (!tool) {
          throw new Error(`Plugin did not register ${name}`);
        }
        return tool.execute("visitor-test-call", input);
      },
    };
  }

  it("keeps CLI metadata discovery free of runtime access and background work", () => {
    const api = createTestPluginApi({ registrationMode: "cli-metadata" });
    const runtime = vi.fn(() => {
      throw new Error("Metadata discovery accessed runtime");
    });
    Object.defineProperty(api, "runtime", { get: runtime });
    expect(() => plugin.register(api)).not.toThrow();
    expect(runtime).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves unbound staff admission when staff is the default role", () => {
    const config: OpenClawConfig = {
      gateway: {
        roles: {
          default: "staff",
          definitions: {
            staff: { sessions: { others: "write" }, agents: "*", scopes: ["operator.admin"] },
          },
        },
      },
    };
    const registered = registerPlugin({}, config);
    expect(
      registered.authorize(
        {
          profileId: "staff-profile",
          emails: ["staff@example.test"],
          assignedRole: "staff",
        },
        false,
      ),
    ).toBeUndefined();
    expect(registered.gatewayRequest).not.toHaveBeenCalled();
  });

  it("returns declared visitor details and selection IDs through registered tools", async () => {
    const policy = createPolicyFetch(["manual@example.test"]);
    vi.stubGlobal("fetch", policy.fetcher);
    const registered = registerPlugin();
    await registered.start();

    const invited = await registered.execute("visitor_invite", {
      email: "visitor@example.test",
      days: 7,
    });
    const listed = await registered.execute("visitor_list");
    const grantId = (await registered.store.lookup("visitor@example.test"))?.grantId;
    const revoked = await registered.execute("visitor_revoke", { email: "visitor@example.test" });
    const absent = await registered.execute("visitor_revoke", { email: "visitor@example.test" });

    expect(invited.content).toEqual([
      {
        type: "text",
        text: `Invited visitor@example.test. Invitation ID: ${grantId}. Visitor grant expires: 2026-08-08T00:00:00.000Z. Gateway access: restricted guest (default role "external-work"; first sign-in pending). Sign in at https://team.openclaw.ai using Team's existing login with this email. The link itself does not grant access.`,
      },
    ]);
    expect(listed.content).toEqual([
      {
        type: "text",
        text: [
          "Visitors: 1 recorded; 2 in policy. Drift: 1 unmanaged, 0 missing from policy.",
          `visitor@example.test | GitHub unknown | grantId ${grantId} | invited 2026-08-01T00:00:00.000Z | grant expires 2026-08-08T00:00:00.000Z | managed | Gateway access: restricted guest (default role "external-work"; first sign-in pending)`,
          'manual@example.test | UNMANAGED: no grant record; retained until explicit revoke. | Gateway access: restricted guest (default role "external-work"; first sign-in pending)',
        ].join("\n"),
      },
    ]);
    expect(revoked.content).toEqual([
      { type: "text", text: "Revoked visitor access for visitor@example.test." },
    ]);
    expect(absent.content).toEqual([
      { type: "text", text: "No visitor grant found for visitor@example.test; nothing to revoke." },
    ]);

    const gatewayAccess =
      'Gateway access: restricted guest (default role "external-work"; first sign-in pending)';
    expect(invited.details).toEqual({
      outcome: "invited",
      email: "visitor@example.test",
      grantId,
      expiresAt: "2026-08-08T00:00:00.000Z",
      gatewayAccess,
      signInUrl: "https://team.openclaw.ai",
    });
    expect(listed.details).toEqual({
      counts: { recorded: 1, inPolicy: 2, unmanaged: 1, missingFromPolicy: 0 },
      grants: [
        {
          email: "visitor@example.test",
          grantId,
          invitedAt: "2026-08-01T00:00:00.000Z",
          expiresAt: "2026-08-08T00:00:00.000Z",
          state: "managed",
          gatewayAccess,
        },
      ],
      unmanaged: [{ email: "manual@example.test", gatewayAccess }],
      omitted: 0,
    });
    expect(revoked.details).toEqual({ outcome: "revoked", emails: ["visitor@example.test"] });
    expect(absent.details).toEqual({ outcome: "not_found", emails: ["visitor@example.test"] });
    for (const [name, result] of [
      ["visitor_invite", invited],
      ["visitor_list", listed],
      ["visitor_revoke", revoked],
      ["visitor_revoke", absent],
    ] as const) {
      const schema = registered.tools.get(name)?.outputSchema;
      if (!schema) {
        throw new Error(`${name} did not declare an output schema`);
      }
      expect(Value.Check(schema, result.details)).toBe(true);
    }
  });

  async function startVisitors() {
    const emails = [
      "first@example.test",
      "alias@example.test",
      "staff@example.test",
      "pending@example.test",
    ] as const;
    const policy = createPolicyFetch([...emails, "manual@example.test"]);
    vi.stubGlobal("fetch", policy.fetcher);
    const registered = registerPlugin();
    const profiles = [
      { id: "visitor-profile", emails: emails.slice(0, 2) },
      { id: "staff-profile", emails: [emails[2]], role: "staff" },
    ];
    registered.setProfiles(profiles);
    await registered.start();
    for (const email of emails) {
      await expect(registered.execute("visitor_invite", { email })).resolves.not.toHaveProperty(
        "isError",
      );
    }
    policy.fetcher.mockClear();
    return { ...registered, policy, profiles, emails };
  }

  it("distinguishes person-wide revocation from exact pending invitation cancellation", async () => {
    const registered = await startVisitors();
    const [first, alias, staff, pending] = registered.emails;
    const pendingGrant = await registered.store.lookup(pending);
    expect(pendingGrant?.grantId).toEqual(expect.any(String));
    const listed = await registered.execute("visitor_list");
    expect(listed.details).toMatchObject({
      grants: [
        { email: alias, profileId: "visitor-profile", grantId: expect.any(String) },
        { email: first, profileId: "visitor-profile", grantId: expect.any(String) },
        { email: pending, grantId: pendingGrant?.grantId },
        { email: staff, profileId: "staff-profile", grantId: expect.any(String) },
      ],
    });
    const authorities = [first, alias].map((email) =>
      registered.authorize({
        profileId: "visitor-profile",
        emails: [email],
        assignedRole: null,
      }),
    );
    expect(authorities.every(Boolean)).toBe(true);
    await registered.execute("visitor_invite", { email: pending, days: 30 });
    expect((await registered.store.lookup(pending))?.grantId).toBe(pendingGrant?.grantId);
    await expect(
      registered.execute("visitor_revoke", { grantId: pendingGrant?.grantId }),
    ).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [pending] },
    });
    expect(registered.policy.emails()).toEqual([first, alias, staff, "manual@example.test"]);
    await expect(
      registered.execute("visitor_revoke", { profileId: "visitor-profile" }),
    ).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [alias, first] },
    });
    expect(registered.policy.emails()).toEqual([staff, "manual@example.test"]);
    expect((await registered.store.entries()).map(({ key }) => key)).toEqual([staff]);
    expect(
      registered.authorize(
        { profileId: "staff-profile", emails: [staff], assignedRole: "staff" },
        false,
      ),
    ).toBeUndefined();
    for (const authority of authorities) {
      expect(authority?.signal.aborted).toBe(true);
      expect(() => authority?.assertCurrent()).toThrow(/access ended/);
    }
    await registered.execute("visitor_invite", { email: pending });
    const replacement = await registered.store.lookup(pending);
    expect(replacement?.grantId).not.toBe(pendingGrant?.grantId);
    await expect(
      registered.execute("visitor_revoke", { grantId: pendingGrant?.grantId }),
    ).resolves.toMatchObject({
      details: { outcome: "not_found", emails: [] },
    });
    expect(await registered.store.lookup(pending)).toEqual(replacement);
    expect(registered.policy.emails()).toContain(pending);
  });

  it("ends every selected grant before failed provider cleanup without ending another person's grant", async () => {
    const registered = await startVisitors();
    const selected = registered.authorize({
      profileId: "visitor-profile",
      emails: [registered.emails[0]],
      assignedRole: null,
    });
    const other = registered.authorize({
      profileId: "pending-profile",
      emails: [registered.emails[3]],
      assignedRole: null,
    });
    expect(selected && other).toBeTruthy();
    registered.policy.controls.failWrites = true;
    await expect(
      registered.execute("visitor_revoke", { profileId: "visitor-profile" }),
    ).resolves.toHaveProperty("isError", true);
    for (const email of registered.emails.slice(0, 2)) {
      expect(await registered.store.lookup(email)).toMatchObject({ expiresAt: START_MS });
    }
    expect(selected?.signal.aborted).toBe(true);
    expect(() => other?.assertCurrent()).not.toThrow();
    expect(registered.policy.emails()).toContain(registered.emails[0]);
    registered.policy.controls.failWrites = false;
    await expect(
      registered.execute("visitor_revoke", { profileId: "visitor-profile" }),
    ).resolves.toMatchObject({ details: { outcome: "revoked" } });
    expect(registered.policy.emails()).toEqual([
      registered.emails[2],
      registered.emails[3],
      "manual@example.test",
    ]);
  });

  it("rejects changed person bindings after provider reads and ambiguous explicit selectors", async () => {
    const registered = await startVisitors();
    const pending = await registered.store.lookup(registered.emails[3]);
    for (const input of [
      { profileId: "visitor-profile", grantId: pending?.grantId },
      { grantId: pending?.grantId, email: registered.emails[3] },
      { profileId: "merged-profile" },
    ]) {
      await expect(registered.execute("visitor_revoke", input)).resolves.toHaveProperty(
        "isError",
        true,
      );
    }
    expect(registered.policy.fetcher).not.toHaveBeenCalled();
    const original = registered.policy.fetcher.getMockImplementation();
    let reassignedAfterRead = false;
    registered.policy.fetcher.mockImplementation(async (input, init) => {
      const response = await original!(input, init);
      if (init?.method === "GET") {
        reassignedAfterRead = true;
        registered.setProfiles([
          { id: "visitor-profile", emails: [registered.emails[1]] },
          {
            id: "staff-profile",
            emails: [registered.emails[0], registered.emails[2]],
            role: "staff",
          },
        ]);
      }
      return response;
    });
    await expect(
      registered.execute("visitor_revoke", { profileId: "visitor-profile" }),
    ).resolves.toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: "Visitor access operation failed. Check gateway health and retry; use visitor_list to inspect drift.",
        },
      ],
    });
    expect(reassignedAfterRead).toBe(true);
    expect(registered.policy.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(
      true,
    );
    expect(registered.policy.emails()).toEqual([...registered.emails, "manual@example.test"]);
    for (const email of registered.emails.slice(0, 2)) {
      expect(await registered.store.lookup(email)).toMatchObject({ expiresAt: START_MS });
    }
    expect(await registered.store.lookup(registered.emails[2])).toMatchObject({
      expiresAt: START_MS + 14 * DAY_MS,
    });
    expect(await registered.store.lookup(registered.emails[3])).toEqual(pending);
  });

  it("denies available visitor tools without trusted owner authority", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const registered = registerPlugin({ senderIsOwner: undefined });
    await registered.start();
    policy.fetcher.mockClear();

    for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
      const result = await registered.execute(
        name,
        name === "visitor_list" ? {} : { email: "visitor@example.test" },
      );
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("Only administrators") }],
      });
      const schema = registered.tools.get(name)?.outputSchema;
      if (!schema) {
        throw new Error(`${name} did not declare an output schema`);
      }
      expect(Value.Check(schema, result.details)).toBe(true);
    }

    expect(policy.fetcher).not.toHaveBeenCalled();
    expect(registered.gatewayRequest).not.toHaveBeenCalled();
    expect(await registered.store.entries()).toEqual([]);
  });

  it.each(["invocation", "manager"] as const)(
    "does not renew a grant after %s authority closes during access lookup",
    async (revoked) => {
      const policy = createPolicyFetch();
      vi.stubGlobal("fetch", policy.fetcher);
      let current = true;
      const assertInvocationCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("Invocation is closed");
        }
      });
      const registered = registerPlugin({ assertInvocationCurrent });
      await registered.start();
      const email = "visitor@example.test";
      await expect(registered.execute("visitor_invite", { email, days: 1 })).resolves.toMatchObject(
        { details: { outcome: "invited" } },
      );
      policy.fetcher.mockClear();

      await expect(registered.execute("visitor_invite", { email, days: 2 })).resolves.toMatchObject(
        {
          details: { outcome: "renewed" },
          content: [{ type: "text", text: expect.stringContaining("Renewed") }],
        },
      );
      const renewed = await registered.store.lookup(email);
      expect(renewed).toMatchObject({ createdAt: START_MS, expiresAt: START_MS + 2 * DAY_MS });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      registered.gatewayRequest.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { profiles: [] };
      });
      const invitation = registered.execute("visitor_invite", { email, days: 30 });
      await entered.promise;
      if (revoked === "invocation") {
        current = false;
      } else {
        registered.toolContext.senderIsOwner = false;
      }
      release.resolve();

      await expect(invitation).resolves.toHaveProperty("isError", true);

      expect(policy.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
      expect(policy.emails()).toEqual([email]);
      expect(await registered.store.lookup(email)).toEqual(renewed);
      if (revoked === "manager") {
        expect(assertInvocationCurrent).not.toThrow();
      }
    },
  );

  it("gates registered visitor access across restart, expiry, and failed provider revocation", async () => {
    const grants: VisitorGrant[] = [
      { email: "expired@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 1_000 },
      { email: "deadline@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 2_000 },
      { email: "revoked@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + DAY_MS },
    ];
    const policy = createPolicyFetch(grants.map((grant) => grant.email));
    vi.stubGlobal("fetch", policy.fetcher);
    const first = registerPlugin();
    for (const grant of grants) {
      await first.store.register(grant.email, grant);
    }
    const visitor = {
      profileId: "visitor-profile",
      emails: ["revoked@example.test"],
      assignedRole: "external-work",
    };
    expect(() => first.authorize(visitor)).toThrow(/starting/);
    await first.start();
    const original = first.authorize(visitor);
    if (!original) {
      throw new Error("Expected visitor authority from the registered policy");
    }
    await first.stop();
    expect(original.signal.aborted).toBe(true);
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + 1_000);
    policy.controls.failWrites = true;

    const restarted = registerPlugin();
    await restarted.start();
    expect(restarted.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("visitor-access sweep failed"),
    );
    for (const assignedRole of [null, "external-work", "removed-role"]) {
      for (const email of ["missing@example.test", "expired@example.test"]) {
        expect(() => restarted.authorize({ ...visitor, emails: [email], assignedRole })).toThrow(
          /active visitor invitation/,
        );
      }
    }
    for (const profile of [
      { profileId: "staff-profile", emails: ["expired@example.test"], assignedRole: "staff" },
      { profileId: "gateway-owner", emails: [], assignedRole: null },
    ]) {
      expect(restarted.authorize(profile, false)).toBeUndefined();
    }
    const deadline = restarted.authorize({
      ...visitor,
      emails: ["other-verified@example.test", "deadline@example.test"],
    });
    const revoked = restarted.authorize(visitor);
    if (!deadline || !revoked) {
      throw new Error("Expected initialized active visitor grants");
    }
    expect(() => deadline.assertCurrent()).not.toThrow();
    expect(() => revoked.assertCurrent()).not.toThrow();
    await expect(
      restarted.execute("visitor_revoke", { email: "revoked@example.test" }),
    ).resolves.toMatchObject({ details: { error: true } });
    expect(revoked.signal.aborted).toBe(true);
    expect(() => revoked.assertCurrent()).toThrow(/access ended/);
    expect(() => restarted.authorize(visitor)).toThrow(/active visitor invitation/);
    expect(await restarted.store.lookup("revoked@example.test")).toMatchObject({
      expiresAt: START_MS + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deadline.signal.aborted).toBe(true);
    expect(() => deadline.assertCurrent()).toThrow(/access ended/);
    expect(policy.emails()).toEqual(grants.map((grant) => grant.email));
    expect(await restarted.store.entries()).toHaveLength(grants.length);
  });

  it("revokes persisted expiries after restart, coalesces startup, and continues hourly", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const first = registerPlugin();
    await first.start();
    await expect(
      first.execute("visitor_invite", { email: "expired@example.test", days: 1 }),
    ).resolves.toMatchObject({
      details: { outcome: "invited" },
      content: [{ type: "text", text: expect.stringContaining("restricted guest") }],
    });
    await expect(
      first.execute("visitor_invite", { email: "active@example.test", days: 2 }),
    ).resolves.toMatchObject({ details: { outcome: "invited" } });
    await first.stop();
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + DAY_MS + 1);
    policy.fetcher.mockClear();

    const restarted = registerPlugin();
    await Promise.all([restarted.start(), restarted.gatewayStart()]);
    expect(policy.emails()).toEqual(["active@example.test"]);
    expect((await restarted.store.entries()).map((entry) => entry.key)).toEqual([
      "active@example.test",
    ]);
    expect(policy.fetcher.mock.calls.filter(([url]) => requestUrl(url).search !== "")).toHaveLength(
      1,
    );
    expect(restarted.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("expired@example.test"),
    );

    vi.setSystemTime(START_MS + 2 * DAY_MS);
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await restarted.execute("visitor_list");
    expect(policy.emails()).toEqual([]);
    expect(await restarted.store.entries()).toEqual([]);
    await restarted.stop();
    const callsAfterStop = policy.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(policy.fetcher).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("stops the scheduler, aborts an in-flight sweep, and rejects retained tools", async () => {
    const entered = createDeferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("Expiry requests must be cancellable");
      }
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)), {
          once: true,
        });
        entered.resolve(signal);
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const registered = registerPlugin();
    const starting = registered.start();
    const signal = await entered.promise;
    await registered.stop();
    await starting;
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const callsAfterStop = fetcher.mock.calls.length;
    const result = await registered.execute("visitor_invite", { email: "late@example.test" });
    expect(result).toMatchObject({ details: { error: true } });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterStop);
    expect(await registered.store.entries()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(registered.logger.error).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous invite inactive and sweepable across the registered service restart", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const registered = registerPlugin();
    await registered.start();
    policy.controls.loseWriteResponse = true;
    const result = await registered.execute("visitor_invite", { email: "pending@example.test" });
    expect(result).toMatchObject({ details: { error: true }, content: [{ type: "text" }] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(await registered.store.lookup("pending@example.test")).toMatchObject({
      email: "pending@example.test",
      invitedVia: "agent:main:maintainer",
      expiresAt: START_MS,
    });
    const profile = {
      profileId: "pending-visitor",
      emails: ["pending@example.test"],
      assignedRole: "external-work",
    };
    expect(policy.emails()).toEqual(profile.emails);
    expect(() => registered.authorize(profile)).toThrow(/active visitor invitation/);
    await registered.stop();
    resetPluginStateStoreForTests();
    policy.controls.loseWriteResponse = false;
    const restarted = registerPlugin();
    await restarted.start();
    expect(() => restarted.authorize(profile)).toThrow(/active visitor invitation/);
    expect(await restarted.store.lookup("pending@example.test")).toBeUndefined();
    expect(policy.emails()).toEqual([]);
  });

  it("routes discovery tools through the Gateway owner and fences them after replacement", async () => {
    const policy = createPolicyFetch();
    vi.stubGlobal("fetch", policy.fetcher);
    const owner = registerPlugin();
    await owner.start();
    let invite: AnyAgentTool | undefined;
    const discovery = createTestPluginApi({
      registrationMode: "tool-discovery",
      registerTool(registration) {
        const context: OpenClawPluginToolContext<2> = {
          senderIsOwner: true,
          assertInvocationCurrent() {},
        };
        const tools =
          typeof registration === "function"
            ? registration(context)
            : "contextVersion" in registration
              ? registration.create(context)
              : registration;
        invite =
          (Array.isArray(tools) ? tools : tools ? [tools] : []).find(
            (tool) => tool.name === "visitor_invite",
          ) ?? invite;
      },
    });
    Object.defineProperty(discovery, "runtime", {
      get() {
        throw new Error("Discovery must use the active Gateway owner");
      },
    });
    plugin.register(discovery);
    if (!invite) {
      throw new Error("Discovery did not register visitor_invite");
    }
    await expect(
      invite.execute("invite", { email: "discovered@example.test" }),
    ).resolves.toMatchObject({ details: { outcome: "invited" } });
    expect(await owner.store.lookup("discovered@example.test")).toBeDefined();
    await owner.stop();
    const replacement = registerPlugin();
    await replacement.start();
    const callsBeforeStaleTool = policy.fetcher.mock.calls.length;
    await expect(invite.execute("stale", { email: "late@example.test" })).resolves.toHaveProperty(
      "details.error",
      true,
    );
    expect(policy.fetcher).toHaveBeenCalledTimes(callsBeforeStaleTool);
    await expect(
      replacement.execute("visitor_invite", { email: "current@example.test" }),
    ).resolves.toMatchObject({ details: { outcome: "invited" } });
  });
});
