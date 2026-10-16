import type { GatewayMessageCreateDispatchData } from "discord-api-types/v10";
import {
  GatewayDispatchEvents,
  GatewayIntentBits,
  GuildMemberFlags,
  PermissionFlagsBits,
} from "discord-api-types/v10";
import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import {
  registerSessionBindingAdapterV2,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapterV2,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { describe, expect, it, vi } from "vitest";
import { Client } from "../internal/discord.js";
import { GatewayPlugin } from "../internal/gateway.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { DiscordThreadAutoNamer } from "./thread-auto-name.js";

// Only Discord's state binding is supplied by the fixture. The title helper,
// conversation label generator, isolated completion, and credential preparation are real.
vi.mock("../runtime.js", async (original) => ({
  ...(await original<typeof import("../runtime.js")>()),
  getDiscordRuntime: () => ({
    state: {
      openKeyedStoreV2: <T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreV2ForTests<T>("discord", options, { assertCurrent() {} }),
    },
  }),
}));

const GUILD = "123456789012345678";
const PARENT = "223456789012345678";
const BOT = "323456789012345678";
const USER = "423456789012345678";
const PROVIDER = "discord-title-fixture";
const ASSIGNED_PROVIDER = "discord-assigned-title-fixture";
const ASSIGNED_API_KEY = "synthetic-assigned-title-fixture-key";
const ROUTE_ROLE = "523456789012345678";
const HARNESS = "discord-title-fixture-harness";
const API_KEY = "synthetic-title-fixture-key";
const FIXTURE_HARNESS = Symbol.for("openclaw.discordTitleRuntimeTestHarness");

type CompletionParams = Parameters<NonNullable<AgentHarness["runIsolatedCompletionV2"]>>[0];
type RoutingScenario = "parent" | "account" | "role" | "bound";

async function fixture(state: OpenClawTestState, routing?: RoutingScenario) {
  const pluginRoot = state.statePath("title-fixture-plugin");
  const providerIds = routing ? [PROVIDER, ASSIGNED_PROVIDER] : [PROVIDER];
  // Keep a released default marker so the old namer dispatches to the wrong provider,
  // rather than stopping at ambiguous agent selection before reaching the regression.
  const mainAgent = { workspace: state.workspaceDir, ...(routing ? { default: true } : {}) };
  const modelDefinitions = ["utility", "primary"].map((id) => ({
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16_384,
    maxTokens: 4_096,
  }));
  let cfg: OpenClawConfig = {
    meta: { migrations: { utilityModelSeparation: true } },
    agents: {
      entries: routing
        ? {
            main: mainAgent,
            assigned: {
              model: { primary: `${ASSIGNED_PROVIDER}/primary` },
              utilityModel: `${ASSIGNED_PROVIDER}/utility`,
            },
          }
        : { main: mainAgent },
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: `${PROVIDER}/primary` },
        utilityModel: `${PROVIDER}/utility`,
      },
    },
    plugins: {
      load: { paths: [pluginRoot] },
      slots: { memory: "none" },
      entries: { [HARNESS]: { enabled: true } },
    },
    models: {
      providers: {
        [PROVIDER]: {
          baseUrl: "https://synthetic-title-fixture.invalid/v1",
          api: "openai-completions",
          apiKey: API_KEY,
          agentRuntime: { id: HARNESS },
          models: modelDefinitions,
        },
        ...(routing
          ? {
              [ASSIGNED_PROVIDER]: {
                baseUrl: "https://synthetic-assigned-title-fixture.invalid/v1",
                api: "openai-completions" as const,
                apiKey: ASSIGNED_API_KEY,
                agentRuntime: { id: HARNESS },
                models: modelDefinitions,
              },
            }
          : {}),
      },
    },
    channels: {
      discord: {
        token: "synthetic-discord-token",
        groupPolicy: "allowlist",
        thread: { autoName: 1 },
        intents: { guildMembers: true },
        guilds: { [GUILD]: { users: [USER], channels: { [PARENT]: {} } } },
      },
    },
  };
  if (routing) {
    cfg.bindings = [
      {
        agentId: routing === "bound" ? "main" : "assigned",
        match: {
          channel: "discord",
          accountId: "default",
          ...(routing === "parent" || routing === "bound"
            ? { peer: { kind: "channel" as const, id: PARENT } }
            : routing === "role"
              ? { guildId: GUILD, roles: [ROUTE_ROLE] }
              : {}),
        },
      },
    ];
  }
  await state.writeConfig(cfg);
  await state.writeAuthProfiles({
    version: 1,
    profiles: { [`${PROVIDER}:fixture`]: { type: "api_key", provider: PROVIDER, key: API_KEY } },
  });
  if (routing) {
    await state.writeAuthProfiles(
      {
        version: 1,
        profiles: {
          [`${ASSIGNED_PROVIDER}:fixture`]: {
            type: "api_key",
            provider: ASSIGNED_PROVIDER,
            key: ASSIGNED_API_KEY,
          },
        },
      },
      "assigned",
    );
  }
  const dispatches: CompletionParams[] = [];
  let beforePreparation: (() => void) | undefined;
  let afterUtilityFailure: (() => void) | undefined;
  let failUtility = false;
  let preparations = 0;
  const harness: AgentHarness = {
    id: HARNESS,
    label: "Synthetic title harness",
    supports: () => {
      preparations += 1;
      beforePreparation?.();
      return { supported: true };
    },
    runAttempt: async () => {
      throw new Error("The title fixture must use isolated completion");
    },
    runIsolatedCompletionV2: async (params) => {
      dispatches.push(params);
      if (params.modelId === "utility" && failUtility) {
        afterUtilityFailure?.();
        throw new Error("Synthetic utility provider failure");
      }
      return {
        assistant: {
          role: "assistant",
          content: [{ type: "text", text: "Release planning" }],
          api: "openai-completions",
          provider: params.provider,
          model: params.modelId,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      };
    },
  };
  Reflect.set(globalThis, FIXTURE_HARNESS, harness);
  await state.writeJson("title-fixture-plugin/openclaw.plugin.json", {
    id: HARNESS,
    providers: providerIds,
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  await state.writeJson("title-fixture-plugin/package.json", {
    name: "discord-title-runtime-fixture",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  await state.writeText(
    "title-fixture-plugin/index.js",
    `
export default {
  id: ${JSON.stringify(HARNESS)},
  register(api) {
    const harness = globalThis[Symbol.for("openclaw.discordTitleRuntimeTestHarness")];
    if (!harness) throw new Error("Missing synthetic title harness");
    for (const id of ${JSON.stringify(providerIds)}) {
      api.registerProvider({ id, label: "Synthetic title provider", auth: [] });
    }
    api.registerAgentHarness(harness);
  }
};
`,
  );
  const patches: unknown[] = [];
  const now = Date.now();
  const snowflake = (sequence: number) =>
    ((BigInt(now - 1_420_070_400_000) << 22n) + BigInt(sequence)).toString();
  const threadId = snowflake(0);
  let currentBinding: SessionBindingRecord | null =
    routing === "bound"
      ? {
          bindingId: "synthetic-focused-thread",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: threadId,
            parentConversationId: PARENT,
          },
          targetSessionKey: "agent:assigned:focused-title-session",
          targetKind: "session",
          status: "active",
          boundAt: now,
          metadata: { boundBy: USER },
        }
      : null;
  let bindingOwnerActive = true;
  const lookup = (ref: SessionBindingRecord["conversation"]) =>
    ref.conversationId === threadId ? currentBinding : null;
  const legacyRead = () => {
    throw new Error("Title routing must not use synchronous binding compatibility reads");
  };
  const bindingAdapter: SessionBindingAdapterV2 = {
    version: 2,
    channel: "discord",
    accountId: "default",
    assertCurrent: () => {
      if (!bindingOwnerActive) {
        throw new Error("Synthetic binding owner was retired");
      }
    },
    inspectByConversationsAsync: async (refs) => {
      const bindings = refs.map(lookup);
      return {
        bindings,
        assertCurrent: () => {
          bindingAdapter.assertCurrent();
          if (refs.some((ref, index) => lookup(ref) !== bindings[index])) {
            throw new Error("Synthetic thread binding selection changed");
          }
        },
      };
    },
    listBySession: legacyRead,
    resolveByConversation: legacyRead,
    listBySessionAsync: async () => [],
    resolveByConversationAsync: async (ref) => lookup(ref),
    inspectByConversationAsync: async (ref) => lookup(ref),
    touchAsync: async () => {},
  };
  registerSessionBindingAdapterV2(bindingAdapter);
  let currentRoles = routing === "role" ? [ROUTE_ROLE] : [];
  const client = new Client(
    {
      clientId: BOT,
      token: "synthetic-discord-token",
      requestOptions: {
        queueRequests: false,
        fetch: async (input, init) => {
          const path = new URL(
            input instanceof Request ? input.url : input instanceof URL ? input.href : input,
          ).pathname.replace(/^\/api\/v\d+/, "");
          if (init?.method === "PATCH") {
            if (typeof init.body !== "string") {
              throw new Error("Expected serialized JSON PATCH body");
            }
            patches.push(JSON.parse(init.body));
            return Response.json({ id: threadId, name: "Release planning" });
          }
          if (path === `/guilds/${GUILD}`) {
            return Response.json({
              id: GUILD,
              name: "Synthetic title guild",
              owner_id: "owner",
              roles: [{ id: GUILD, permissions: PermissionFlagsBits.ManageThreads.toString() }],
            });
          }
          if (path.startsWith(`/guilds/${GUILD}/members/`)) {
            return Response.json({
              roles: path.endsWith(`/${USER}`) ? currentRoles : [],
              flags: GuildMemberFlags.CompletedOnboarding,
            });
          }
          if (path === `/channels/${PARENT}`) {
            return Response.json({ id: PARENT, guild_id: GUILD, type: 0, name: "planning" });
          }
          if (path === `/channels/${threadId}`) {
            return Response.json({
              id: threadId,
              guild_id: GUILD,
              parent_id: PARENT,
              type: 11,
              name: "Untitled",
            });
          }
          throw new Error(`Unexpected Discord fixture path: ${path}`);
        },
      },
    },
    {},
  );
  const gateway = new GatewayPlugin({ intents: GatewayIntentBits.GuildMembers });
  gateway.isConnected = true; // Fixed transport state; no live socket or credentials.
  client.plugins.push(gateway);
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    readConfig: () => cfg,
    accountId: "default",
    token: "synthetic-discord-token",
    discordRestFetch: client.rest.options.fetch,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const namer = new DiscordThreadAutoNamer({
    cfg,
    readPolicy,
    accountId: "default",
    botUserId: BOT,
  });
  namer.onThreadCreate({
    id: threadId,
    guild_id: GUILD,
    parent_id: PARENT,
    name: "Untitled",
    newly_created: true,
  });
  const message: GatewayMessageCreateDispatchData = {
    id: snowflake(1),
    channel_id: threadId,
    guild_id: GUILD,
    author: {
      id: USER,
      username: "fixture-user",
      discriminator: "0",
      global_name: null,
      avatar: null,
    },
    member: {
      roles: [],
      flags: GuildMemberFlags.CompletedOnboarding,
      joined_at: new Date(now).toISOString(),
      deaf: false,
      mute: false,
    },
    type: 0,
    content: "Plan the release",
    attachments: [],
    embeds: [],
    timestamp: new Date(now).toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    pinned: false,
  };
  const revoke = () => {
    cfg = {
      ...cfg,
      channels: { ...cfg.channels, discord: { ...cfg.channels?.discord, groupPolicy: "disabled" } },
    };
  };
  return {
    dispatches,
    patches,
    namer,
    get preparations() {
      return preparations;
    },
    run: () => namer.onMessage(message, client),
    revoke,
    prepare: (callback: () => void) => {
      beforePreparation = callback;
    },
    utilityFailure: (callback?: () => void) => {
      failUtility = true;
      afterUtilityFailure = callback;
    },
    updateMember: (userId = USER) => {
      if (userId === USER) {
        currentRoles = [];
      }
      void client.dispatchGatewayEvent(GatewayDispatchEvents.GuildMemberUpdate, {
        guild_id: GUILD,
        user: { id: userId },
        roles: [],
      });
    },
    rebind: () => {
      if (!currentBinding) {
        throw new Error("Expected the focused thread binding");
      }
      currentBinding = { ...currentBinding, targetSessionKey: "agent:main:focused-title-session" };
    },
    reroute: () => {
      cfg = {
        ...cfg,
        bindings: [{ agentId: "main", match: { channel: "discord", accountId: "default" } }],
      };
    },
    cleanup: async () => {
      namer.stop();
      bindingOwnerActive = false;
      unregisterSessionBindingAdapter({
        channel: "discord",
        accountId: "default",
        adapter: bindingAdapter,
      });
      const registry = getActivePluginRegistry();
      if (registry) {
        await disposePluginRegistryInstances(registry);
      }
      resetPluginRuntimeStateForTest();
      resetPluginStateStoreForTests();
      Reflect.deleteProperty(globalThis, FIXTURE_HARNESS);
    },
  };
}

async function isolated(
  run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  routing?: RoutingScenario,
) {
  await withOpenClawTestState({ label: "discord-title-real-runtime" }, async (state) => {
    const value = await fixture(state, routing);
    try {
      await run(value);
    } finally {
      await value.cleanup();
    }
  });
}

describe("Discord auto-name through the conversation-label runtime", () => {
  it.each(["parent", "account", "role", "bound"] as const)(
    "keeps the transcript and credentials with the assigned agent through %s routing",
    async (routing) =>
      isolated(async (value) => {
        await value.run();
        expect(
          value.dispatches.map(({ agentId, provider, modelId }) => ({
            agentId,
            provider,
            modelId,
          })),
        ).toEqual([{ agentId: "assigned", provider: ASSIGNED_PROVIDER, modelId: "utility" }]);
        expect(value.dispatches[0]?.authorization).toMatchObject({
          owner: "host",
          auth: { apiKey: ASSIGNED_API_KEY },
        });
        expect(value.dispatches[0]?.prompt).toContain("Plan the release");
        expect(value.patches).toEqual([{ name: "Release planning" }]);
      }, routing),
  );

  it.each([
    { routing: "bound", phase: "preparation" },
    { routing: "bound", phase: "fallback" },
    { routing: "account", phase: "preparation" },
    { routing: "account", phase: "fallback" },
  ] as const)(
    "stops title effects after $routing ownership changes during $phase",
    async ({ routing, phase }) =>
      isolated(async (value) => {
        const changeOwner = routing === "bound" ? value.rebind : value.reroute;
        if (phase === "preparation") {
          value.prepare(changeOwner);
        } else {
          value.utilityFailure(changeOwner);
        }
        await value.run();
        expect(
          value.dispatches.map(({ agentId, provider, modelId }) => ({
            agentId,
            provider,
            modelId,
          })),
        ).toEqual(
          phase === "fallback"
            ? [{ agentId: "assigned", provider: ASSIGNED_PROVIDER, modelId: "utility" }]
            : [],
        );
        expect(value.patches).toEqual([]);
      }, routing),
  );

  it.each([false, true])(
    "dispatches allowed utility/primary completion (fallback=%s)",
    async (fallback) =>
      isolated(async (value) => {
        if (fallback) {
          value.utilityFailure();
        }
        await value.run();
        expect(value.preparations).toBeGreaterThan(0);
        expect(value.dispatches.map((params) => params.modelId)).toEqual(
          fallback ? ["utility", "primary"] : ["utility"],
        );
        for (const dispatch of value.dispatches) {
          expect(dispatch.authorization).toMatchObject({
            owner: "host",
            auth: { apiKey: API_KEY },
          });
          expect(dispatch.prompt).toContain("Plan the release");
        }
        expect(value.patches).toEqual([{ name: "Release planning" }]);
      }),
  );

  it.each(["allowed", "revoked"] as const)(
    "retains %s member authority during model preparation and fallback",
    async (authority) =>
      isolated(async (value) => {
        value.prepare(() => value.updateMember(authority === "revoked" ? USER : "another-human"));
        value.utilityFailure();
        await value.run();
        expect(value.preparations).toBeGreaterThan(0);
        expect(value.dispatches.map(({ modelId }) => modelId)).toEqual(
          authority === "revoked" ? [] : ["utility", "primary"],
        );
        expect(value.patches).toEqual(
          authority === "revoked" ? [] : [{ name: "Release planning" }],
        );
      }, "role"),
  );

  it("blocks primary fallback after a native role revocation", async () =>
    isolated(async (value) => {
      value.utilityFailure(value.updateMember);
      await value.run();
      expect(value.dispatches.map(({ modelId }) => modelId)).toEqual(["utility"]);
      expect(value.patches).toEqual([]);
    }, "role"));

  it.each(["revoke", "stop"] as const)(
    "blocks real dispatch when %s occurs during runtime preparation",
    async (kind) =>
      isolated(async (value) => {
        value.prepare(() => (kind === "stop" ? value.namer.stop() : value.revoke()));
        await value.run();
        expect(value.preparations).toBeGreaterThan(0);
        expect(value.dispatches.map((params) => params.modelId)).toEqual([]);
        expect(value.patches).toEqual([]);
      }),
  );

  it.each(["revoke", "stop"] as const)(
    "does not enter primary fallback after utility failure and %s",
    async (kind) =>
      isolated(async (value) => {
        value.utilityFailure(() => (kind === "stop" ? value.namer.stop() : value.revoke()));
        await value.run();
        expect(value.dispatches.map((params) => params.modelId)).toEqual(["utility"]);
        expect(value.patches).toEqual([]);
      }),
  );
});
