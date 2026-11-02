import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  AnyAgentTool,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { VisitorGrant } from "./src/grant-record.js";
import { visitorRuntimeStore } from "./src/runtime.js";
import { visitorListDetailsSchema, type VisitorListDetails } from "./src/tool-results.js";
import {
  githubProvider,
  guestRole,
  namedPolicy,
  staffRole,
  visitorProfileFixture,
} from "./src/visitors.test-support.js";

type PluginGatewayAccessPolicy = Parameters<OpenClawPluginApi["registerGatewayAccessPolicy"]>[0];

const TOKEN = "visitor-test-token-never-echo";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const visitorProfile = (
  emails: string[],
  assignedRole: string | null = null,
  profileId = "visitor-profile",
) => ({ profileId, emails, assignedRole });
const policiesUrl =
  "https://api.cloudflare.com/client/v4/accounts/test-account/access/apps/test-app/policies";
const gatewayConfig: OpenClawConfig = {
  gateway: {
    roles: {
      default: "external-work",
      definitions: {
        "external-work": guestRole,
        staff: staffRole,
      },
    },
  },
};

function resolveTools(
  registration: Parameters<OpenClawPluginApi["registerTool"]>[0],
  context: OpenClawPluginToolContext<2>,
) {
  const tools =
    typeof registration === "function"
      ? registration(context)
      : "contextVersion" in registration
        ? registration.create(context)
        : registration;
  return Array.isArray(tools) ? tools : tools ? [tools] : [];
}

const textContaining = (text: string) => [{ type: "text", text: expect.stringContaining(text) }];

async function expectOutcome(result: Promise<unknown>, outcome: string, text?: string) {
  await expect(result).resolves.toMatchObject({
    details: { outcome },
    ...(text === undefined ? {} : { content: textContaining(text) }),
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  return new URL(input instanceof Request ? input.url : input);
}

function createPolicyFetch(initialTargets: Array<string | number> = []) {
  let targets = [...initialTargets];
  const controls = { failWrites: false, loseWriteResponse: false };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    assert(url.href.startsWith(policiesUrl), `Unexpected test request: ${url}`);
    const policy = namedPolicy(targets);
    if (init?.method === "GET") {
      const result = url.search ? (targets.length ? [policy] : []) : policy;
      return Response.json({ success: true, result });
    }
    if (controls.failWrites) {
      return new Response("Unavailable", { status: 503 });
    }
    if (init?.method === "DELETE") {
      targets = [];
    } else {
      assert(typeof init?.body === "string", "Expected a JSON policy body");
      const body: unknown = JSON.parse(init.body);
      const schema = Type.Object({
        include: Type.Array(
          Type.Union([
            Type.Object({ email: Type.Object({ email: Type.String() }) }),
            Type.Object({
              oidc: Type.Object({
                identity_provider_id: Type.Literal(githubProvider.providerId),
                claim_name: Type.Literal(githubProvider.githubAccountIdClaim),
                claim_value: Type.Literal("42"),
              }),
            }),
          ]),
        ),
      });
      assert(Value.Check(schema, body), "Unexpected visitor policy rules");
      targets = body.include.map((rule) =>
        "email" in rule ? rule.email.email : Number(rule.oidc.claim_value),
      );
    }
    if (controls.loseWriteResponse) {
      throw new Error(`Transport failure with Authorization: Bearer ${TOKEN}`);
    }
    return Response.json({ success: true, result: {} });
  });
  return {
    fetcher,
    emails: () => targets.filter((target) => typeof target === "string"),
    controls,
  };
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
    githubProfiles: Parameters<typeof visitorProfileFixture>[1] = [],
  ) {
    const tools = new Map<string, AnyAgentTool>();
    const backgroundTasks: Promise<unknown>[] = [];
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
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
        for (const tool of resolveTools(registration, toolContext)) {
          tools.set(tool.name, tool);
        }
      },
    });
    api.lifecycle.runInBackgroundContext = (run) => {
      const result = run();
      if (result instanceof Promise) {
        backgroundTasks.push(result);
      }
      return result;
    };
    api.runtime.state = {
      ...api.runtime.state,
      openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("visitor-access", { ...options, env }),
    };
    const directory = visitorProfileFixture([], githubProfiles);
    api.runtime.gateway = directory.gateway;
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
    assert(service, "Plugin did not register its expiry service");
    const accessPolicy = accessPolicies[0];
    assert(accessPolicy, "Plugin did not register its Gateway access policy");
    const scheduler = createTestPluginServiceScheduler();
    const context: OpenClawPluginServiceContextV2 = { config: {}, stateDir, logger, scheduler };
    const stop = async () => {
      scheduler.beginClose();
      try {
        await service.stop?.(context);
      } finally {
        await scheduler.stop();
      }
    };
    cleanups.push(stop);
    const store = createPluginStateKeyedStoreForTests<VisitorGrant>("visitor-access", {
      namespace: "visitor-grants",
      maxEntries: 500,
      overflowPolicy: "reject-new",
      env,
    });
    const execute = async (name: string, input: Record<string, unknown> = {}) => {
      const tool = tools.get(name);
      assert(tool, `Plugin did not register ${name}`);
      const result = await tool.execute("visitor-test-call", input);
      assert(tool.outputSchema, `${name} did not declare an output schema`);
      expect(Value.Check(tool.outputSchema, result.details)).toBe(true);
      return result;
    };
    return {
      execute,
      invite: (input: Record<string, unknown>) => execute("visitor_invite", input),
      revoke: (input: Record<string, unknown>) => execute("visitor_revoke", input),
      list: () => execute("visitor_list"),
      gatewayRequest: directory.request,
      setProfiles: directory.setProfiles,
      logger,
      store,
      authorize: (
        profile: Parameters<PluginGatewayAccessPolicy["authorize"]>[0]["profile"],
        requiredByRole = true,
      ) => accessPolicy.authorize({ config, profile, requiredByRole }),
      toolContext,
      start: () => service.start(context),
      settle: () => Promise.allSettled(backgroundTasks),
      stop,
      gatewayStart: () => {
        const hook = on.mock.calls.find(([name]) => name === "gateway_start")?.[1];
        assert(hook, "Plugin did not register its Gateway startup sweep");
        const startHook = hook as (
          event: { port: number },
          context: { port?: number },
        ) => void | Promise<void>;
        return startHook({ port: 18789 }, {});
      },
    };
  }

  function registerWithPolicy(
    targets: Array<string | number> = [],
    ...args: Parameters<typeof registerPlugin>
  ) {
    const policy = createPolicyFetch(targets);
    vi.stubGlobal("fetch", policy.fetcher);
    return { ...registerPlugin(...args), policy };
  }

  it("persists invitation metadata and a CAS session reservation across restart and renewal", async () => {
    const publicOrigin = "https://team.example.com";
    const first = registerWithPolicy(
      [],
      {},
      { gateway: { ...gatewayConfig.gateway, publicOrigin } },
    );
    await first.start();
    await first.settle();
    const readDirectory = first.gatewayRequest.getMockImplementation()!;
    first.gatewayRequest.mockImplementation(async (method, params) =>
      method === "users.self"
        ? { profile: { id: "inviter", displayName: "Inviter" } }
        : readDirectory(method, params),
    );
    const firstInvite = await first.invite({ email: "visitor@example.test", note: "  Welcome!\n" });
    const invitationText = expect.stringMatching(/^Inviter invited you.*\nSign in at https/u);
    expect(firstInvite.details).toMatchObject({ signInUrl: publicOrigin, invitationText });
    expect(first.gatewayRequest).toHaveBeenCalledWith(
      "users.self",
      {},
      { scopes: ["operator.read"] },
    );
    const service = visitorRuntimeStore.getRuntime().service;
    const { grantId } = (await first.store.lookup("visitor@example.test"))!;
    const invitation = service.findActiveInvitation(grantId!)!;
    const result = await service.compareAndSetOnboarding({
      grantId: invitation.grantId,
      expected: invitation.onboarding!,
      next: { state: "ready", welcomeSessionKey: "welcome", welcomeSessionId: "welcome-id" },
    });
    expect(result.applied).toBe(true);
    await first.stop();
    const second = registerPlugin();
    await second.start();
    await second.invite({ email: "visitor@example.test", days: 30 });
    expect(await second.store.lookup("visitor@example.test")).toMatchObject({
      invitedBy: { profileId: "inviter", label: "Inviter" },
      note: "  Welcome!\n",
      onboarding: { state: "ready", welcomeSessionKey: "welcome", welcomeSessionId: "welcome-id" },
    });
    expect(
      visitorRuntimeStore.getRuntime().service.findActiveInvitation(invitation.grantId),
    ).toEqual(await second.store.lookup("visitor@example.test"));
  });

  it("upgrades a grant recorded by v2026.10.6 without onboarding metadata", async () => {
    // Value recorded by the v2026.10.6 plugin through its registered visitor_invite tool.
    const stableGrant = {
      email: "stable@example.test",
      invitedVia: "agent:main:maintainer",
      createdAt: START_MS,
      expiresAt: START_MS + 7 * DAY_MS,
      grantId: "7b3da382-f824-43ff-ae25-9c8c994ca6f3",
    };
    vi.stubGlobal("fetch", createPolicyFetch([stableGrant.email]).fetcher);
    const upgraded = registerPlugin();
    await upgraded.store.register(stableGrant.email, stableGrant);
    await upgraded.start();
    await upgraded.settle();
    const visitor = { profileId: "stable", emails: [stableGrant.email], assignedRole: null };
    expect(upgraded.authorize(visitor)).toBeDefined();
    const service = visitorRuntimeStore.getRuntime().service;
    expect(service.findActiveInvitation(stableGrant.grantId)).toEqual(stableGrant);
    await expect(
      service.compareAndSetOnboarding({
        grantId: stableGrant.grantId,
        expected: null,
        next: { state: "pending", welcomeSessionKey: "welcome" },
      }),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      upgraded.execute("visitor_invite", { email: stableGrant.email, days: 30 }),
    ).resolves.toMatchObject({ details: { outcome: "renewed" } });
    expect(await upgraded.store.lookup(stableGrant.email)).toEqual({
      ...stableGrant,
      expiresAt: START_MS + 30 * DAY_MS,
      onboarding: { state: "pending", welcomeSessionKey: "welcome", updatedAt: START_MS },
    });
  });

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

  it.each(["email", "github"] as const)(
    "lists verified profile identity for the %s target and revokes by listed profileId",
    async (selector) => {
      const config = structuredClone(gatewayConfig);
      config.gateway = {
        ...config.gateway,
        auth: {
          trustedProxy: {
            userHeader: "cf-access-authenticated-user-email",
            cloudflareAccessOidc: githubProvider,
          },
        },
      };
      const registered = registerWithPolicy([], {}, config, [
        { accountId: 42, profileId: "linked-person" },
      ]);
      const { policy } = registered;
      await registered.start();
      const invited = await registered.invite({
        ...(selector === "email"
          ? { email: "alias@example.test" }
          : { github: "invitation-login" }),
        days: 7,
      });
      expect(invited).not.toHaveProperty("isError", true);
      const key = selector === "email" ? "alias@example.test" : "github:42";
      const recorded = await registered.store.lookup(key);
      assert(recorded, "Missing invitation grant");
      const grant = { ...recorded, githubLogin: "invitation-login" };
      if (selector === "email") {
        await registered.store.register(key, grant);
      }

      const pending = await registered.list();
      expect(pending.details).not.toHaveProperty("grants.0.githubLogin");
      expect(pending.content).toEqual(textContaining("Verified GitHub: unavailable"));
      expect(pending.content).toEqual(textContaining("first sign-in pending"));

      await registered.invite({
        email: "unrelated@example.test",
        days: 7,
      });
      const otherRecorded = await registered.store.lookup("unrelated@example.test");
      assert(otherRecorded, "Missing unrelated invitation grant");
      const otherGrant = { ...otherRecorded, githubLogin: "current-person" };
      await registered.store.register("unrelated@example.test", otherGrant);
      let listedGrant: VisitorListDetails["grants"][number] | undefined;
      for (const login of ["verified-person", null, "current-person"]) {
        registered.setProfiles([
          {
            id: "linked-person",
            emails: ["primary@example.test", "alias@example.test"],
            githubIdentity: login ? { login } : null,
          },
          {
            id: "unrelated-person",
            emails: ["unrelated@example.test"],
            githubIdentity: { login: "other-person" },
          },
        ]);
        const listed = await registered.list();
        expect(listed.content).toEqual(
          textContaining(`Verified GitHub: ${login ? `@${login}` : "unavailable"}`),
        );
        expect(listed.content).not.toEqual(textContaining("first sign-in pending"));
        expect(listed.content).not.toEqual(textContaining("invitation-login"));
        assert(Value.Check(visitorListDetailsSchema, listed.details));
        const target = listed.details.grants.find((entry) => entry.grantId === grant.grantId);
        expect(target).toMatchObject({
          ...(selector === "email" ? { email: "alias@example.test" } : { githubAccountId: 42 }),
          profileId: "linked-person",
          ...(login ? { githubLogin: login } : {}),
        });
        if (!login) {
          expect(target).not.toHaveProperty("githubLogin");
        }
        listedGrant = target;
      }
      expect(await registered.store.lookup(key)).toEqual(grant);
      assert(listedGrant, "Missing listed grant");
      policy.fetcher.mockClear();
      const revoked = await registered.revoke({
        profileId: listedGrant.profileId,
      });
      expect(revoked.details).toEqual({
        outcome: "revoked",
        emails: selector === "email" ? ["alias@example.test"] : [],
        ...(selector === "github" ? { githubAccountIds: [42] } : {}),
      });
      expect(await registered.store.lookup(key)).toBeUndefined();
      expect(await registered.store.lookup("unrelated@example.test")).toEqual(otherGrant);
      expect(policy.emails()).toEqual(["unrelated@example.test"]);
    },
  );

  async function startVisitors() {
    const emails = [
      "first@example.test",
      "alias@example.test",
      "staff@example.test",
      "pending@example.test",
    ] as const;
    const registered = registerWithPolicy([...emails, "manual@example.test"]);
    registered.setProfiles([
      { id: "visitor-profile", emails: emails.slice(0, 2) },
      { id: "staff-profile", emails: [emails[2]], role: "staff" },
    ]);
    await registered.start();
    for (const email of emails) {
      await expect(
        registered.invite({
          email,
          ...(email === emails[0] ? { forever: true } : {}),
        }),
      ).resolves.not.toHaveProperty("isError");
    }
    registered.policy.fetcher.mockClear();
    return { ...registered, emails };
  }

  it("distinguishes person-wide revocation from exact pending invitation cancellation", async () => {
    const registered = await startVisitors();
    const [first, alias, staff, pending] = registered.emails;
    const pendingGrant = await registered.store.lookup(pending);
    const listed = await registered.list();
    assert(Value.Check(visitorListDetailsSchema, listed.details), "Invalid visitor_list details");
    const listedPending = listed.details.grants.find((grant) => grant.email === pending);
    const listedPerson = listed.details.grants.find((grant) => grant.email === first);
    assert(
      listedPending?.grantId && listedPerson?.profileId,
      "Missing listed revocation selectors",
    );
    const authorities = [first, alias].map((email) =>
      registered.authorize(visitorProfile([email])),
    );
    await registered.invite({ email: pending, days: 30 });
    expect((await registered.store.lookup(pending))?.grantId).toBe(pendingGrant?.grantId);
    await expect(registered.revoke({ grantId: listedPending.grantId })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [pending] },
    });
    expect(registered.policy.emails()).toEqual([first, alias, staff, "manual@example.test"]);
    const other = registered.authorize(visitorProfile([staff], null, "staff-profile"));
    expect(other).toBeDefined();
    registered.policy.controls.failWrites = true;
    await expect(registered.revoke({ profileId: listedPerson.profileId })).resolves.toHaveProperty(
      "isError",
      true,
    );
    for (const email of [first, alias]) {
      expect(await registered.store.lookup(email)).toMatchObject({ expiresAt: START_MS });
    }
    for (const authority of authorities) {
      expect(authority?.signal.aborted).toBe(true);
      expect(() => authority?.assertCurrent()).toThrow(/access ended/);
    }
    expect(() => other?.assertCurrent()).not.toThrow();
    expect(registered.policy.emails()).toContain(first);
    registered.policy.controls.failWrites = false;
    await expect(registered.revoke({ profileId: listedPerson.profileId })).resolves.toMatchObject({
      details: { outcome: "revoked", emails: [alias, first] },
    });
    expect(registered.policy.emails()).toEqual([staff, "manual@example.test"]);
    expect((await registered.store.entries()).map(({ key }) => key)).toEqual([staff]);
    expect(
      registered.authorize(visitorProfile([staff], "staff", "staff-profile"), false),
    ).toBeUndefined();
    await registered.invite({ email: pending });
    const replacement = await registered.store.lookup(pending);
    expect(replacement?.grantId).not.toBe(pendingGrant?.grantId);
    await expect(registered.revoke({ grantId: listedPending.grantId })).resolves.toMatchObject({
      details: { outcome: "not_found", emails: [] },
    });
    expect(await registered.store.lookup(pending)).toEqual(replacement);
    expect(registered.policy.emails()).toContain(pending);
  });

  it("rejects changed person bindings after provider reads and ambiguous explicit selectors", async () => {
    const registered = await startVisitors();
    const pending = await registered.store.lookup(registered.emails[3]);
    for (const input of [
      { profileId: "visitor-profile", grantId: pending?.grantId },
      { grantId: pending?.grantId, email: registered.emails[3] },
      { profileId: "merged-profile" },
    ]) {
      await expect(registered.revoke(input)).resolves.toHaveProperty("isError", true);
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
    await expect(registered.revoke({ profileId: "visitor-profile" })).resolves.toHaveProperty(
      "isError",
      true,
    );
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
    const registered = registerWithPolicy([], { senderIsOwner: undefined });
    const { policy } = registered;
    await registered.start();
    await registered.settle();
    policy.fetcher.mockClear();

    for (const name of ["visitor_invite", "visitor_revoke", "visitor_list"]) {
      const result = await registered.execute(
        name,
        name === "visitor_list" ? {} : { email: "visitor@example.test" },
      );
      expect(result).toMatchObject({
        isError: true,
        content: textContaining("Only administrators"),
      });
    }

    expect(policy.fetcher).not.toHaveBeenCalled();
    expect(registered.gatewayRequest).not.toHaveBeenCalled();
    expect(await registered.store.entries()).toEqual([]);
  });

  it.each(["invocation", "manager"] as const)(
    "does not renew a grant after %s authority closes during access lookup",
    async (revoked) => {
      let current = true;
      const assertInvocationCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("Invocation is closed");
        }
      });
      const registered = registerWithPolicy([], { assertInvocationCurrent });
      const { policy } = registered;
      await registered.start();
      const email = "visitor@example.test";
      await expectOutcome(registered.invite({ email, days: 1 }), "invited");
      policy.fetcher.mockClear();

      await expectOutcome(registered.invite({ email, days: 2 }), "renewed", "Renewed");
      const renewed = await registered.store.lookup(email);
      expect(renewed).toMatchObject({ createdAt: START_MS, expiresAt: START_MS + 2 * DAY_MS });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      registered.gatewayRequest.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { profiles: [] };
      });
      const invitation = registered.invite({ email, days: 30 });
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

  it("gates restarted grants through expiry and failed revocation, then retries cleanup hourly", async () => {
    const grants = [
      { email: "expired@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 1_000 },
      { email: "deadline@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + 2_000 },
      { email: "revoked@example.test", createdAt: START_MS - DAY_MS, expiresAt: START_MS + DAY_MS },
    ] satisfies VisitorGrant[];
    const first = registerWithPolicy(grants.map((grant) => grant.email));
    const { policy } = first;
    for (const grant of grants) {
      await first.store.register(grant.email, grant);
    }
    const visitor = visitorProfile(["revoked@example.test"], "external-work");
    expect(() => first.authorize(visitor)).toThrow(/starting/);
    await first.start();
    await first.settle();
    const original = first.authorize(visitor);
    assert(original, "Expected visitor authority from the registered policy");
    policy.controls.loseWriteResponse = true;
    const failedInvite = await first.invite({ email: "pending@example.test" });
    expect(failedInvite).toMatchObject({ details: { error: true }, content: [{ type: "text" }] });
    expect(JSON.stringify(failedInvite)).not.toContain(TOKEN);
    expect(await first.store.lookup("pending@example.test")).toMatchObject({
      email: "pending@example.test",
      invitedVia: "agent:main:maintainer",
      expiresAt: START_MS,
    });
    expect(policy.emails()).toContain("pending@example.test");
    expect(() => first.authorize({ ...visitor, emails: ["pending@example.test"] })).toThrow(
      /active visitor invitation/,
    );
    policy.controls.loseWriteResponse = false;
    await first.stop();
    expect(original.signal.aborted).toBe(true);
    resetPluginStateStoreForTests();
    vi.setSystemTime(START_MS + 1_000);
    policy.controls.failWrites = true;
    policy.fetcher.mockClear();

    const restarted = registerPlugin();
    await Promise.all([restarted.start(), restarted.gatewayStart()]);
    await restarted.settle();
    expect(policy.fetcher.mock.calls.filter(([url]) => requestUrl(url).search !== "")).toHaveLength(
      1,
    );
    expect(restarted.logger.error).toHaveBeenCalled();
    for (const assignedRole of [null, "external-work", "removed-role"]) {
      for (const email of [
        "missing@example.test",
        "expired@example.test",
        "pending@example.test",
      ]) {
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
    assert(deadline && revoked, "Expected initialized active visitor grants");
    expect(() => deadline.assertCurrent()).not.toThrow();
    expect(() => revoked.assertCurrent()).not.toThrow();
    await expect(restarted.revoke({ email: "revoked@example.test" })).resolves.toMatchObject({
      details: { error: true },
    });
    expect(revoked.signal.aborted).toBe(true);
    expect(() => revoked.assertCurrent()).toThrow(/access ended/);
    expect(() => restarted.authorize(visitor)).toThrow(/active visitor invitation/);
    expect(await restarted.store.lookup("revoked@example.test")).toMatchObject({
      expiresAt: START_MS + 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deadline.signal.aborted).toBe(true);
    expect(() => deadline.assertCurrent()).toThrow(/access ended/);
    expect(policy.emails()).toEqual([
      ...grants.map((grant) => grant.email),
      "pending@example.test",
    ]);
    expect(await restarted.store.entries()).toHaveLength(grants.length + 1);
    policy.controls.failWrites = false;
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await restarted.list();
    expect(policy.emails()).toEqual([]);
    expect(await restarted.store.entries()).toEqual([]);
    expect(restarted.logger.info).toHaveBeenCalled();
    await restarted.stop();
    const callsAfterStop = policy.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(policy.fetcher).toHaveBeenCalledTimes(callsAfterStop);
  });

  it("admits only live grants before provider cleanup and aborts that cleanup on stop", async () => {
    const entered = createDeferred<AbortSignal>();
    const fetcher = vi.fn<typeof fetch>((_url, init) => {
      const signal = init?.signal;
      assert(signal, "Expiry requests must be cancellable");
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(`aborted ${TOKEN}`)), {
          once: true,
        });
        entered.resolve(signal);
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const registered = registerPlugin();
    for (const [email, expiresAt] of [
      ["expired@example.test", START_MS],
      ["active@example.test", START_MS + DAY_MS],
    ] as const) {
      await registered.store.register(email, {
        email,
        grantId: "00000000-0000-4000-8000-000000000001",
        createdAt: START_MS - DAY_MS,
        expiresAt,
      });
    }
    await registered.start();
    const signal = await entered.promise;
    const profile = { profileId: "visitor", assignedRole: "external-work" };
    expect(() => registered.authorize({ ...profile, emails: ["expired@example.test"] })).toThrow(
      /active visitor invitation/,
    );
    const authority = registered.authorize({ ...profile, emails: ["active@example.test"] });
    expect(authority).toBeDefined();
    expect(() => authority?.assertCurrent()).not.toThrow();
    await registered.stop();
    expect(authority?.signal.aborted).toBe(true);
    expect(signal.aborted).toBe(true);
    await closeOpenClawStateDatabaseAsync();
    expect(vi.getTimerCount()).toBe(0);
    const callsAfterStop = fetcher.mock.calls.length;
    const result = await registered.invite({ email: "late@example.test" });
    expect(result).toMatchObject({ details: { error: true } });
    expect(fetcher).toHaveBeenCalledTimes(callsAfterStop);
    expect(await registered.store.entries()).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(registered.logger.error).not.toHaveBeenCalled();
  });

  it("routes discovery tools through the Gateway owner and fences them after replacement", async () => {
    const owner = registerWithPolicy();
    const { policy } = owner;
    await owner.start();
    let invite: AnyAgentTool | undefined;
    const discovery = createTestPluginApi({
      registrationMode: "tool-discovery",
      registerTool(registration) {
        const context: OpenClawPluginToolContext<2> = {
          senderIsOwner: true,
          assertInvocationCurrent() {},
        };
        invite =
          resolveTools(registration, context).find((tool) => tool.name === "visitor_invite") ??
          invite;
      },
    });
    Object.defineProperty(discovery, "runtime", {
      get() {
        throw new Error("Discovery must use the active Gateway owner");
      },
    });
    plugin.register(discovery);
    assert(invite, "Discovery did not register visitor_invite");
    await expectOutcome(invite.execute("invite", { email: "discovered@example.test" }), "invited");
    expect(await owner.store.lookup("discovered@example.test")).toBeDefined();
    await owner.stop();
    const replacement = registerPlugin();
    await replacement.start();
    await replacement.settle();
    const callsBeforeStaleTool = policy.fetcher.mock.calls.length;
    await expect(invite.execute("stale", { email: "late@example.test" })).resolves.toHaveProperty(
      "details.error",
      true,
    );
    expect(policy.fetcher).toHaveBeenCalledTimes(callsBeforeStaleTool);
    await expectOutcome(replacement.invite({ email: "current@example.test" }), "invited");
  });
});
