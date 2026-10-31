import { join } from "node:path";
import {
  ApplicationCommandOptionType,
  ChannelType,
  GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import * as commandStatus from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createPluginCommandRuntime,
  type PluginCommandNativeCandidate,
} from "openclaw/plugin-sdk/plugin-command-runtime";
import { clearPluginCommands, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import * as runtimeConfig from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  recordDeliveredCommandExchange,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../channel.js";
import {
  attachRestMock,
  createInternalInteractionPayload,
  createInternalComponentInteractionPayload,
  createInternalTestClient,
} from "../internal/test-builders.test-support.js";
import { getDiscordRuntime, setDiscordRuntime } from "../runtime.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import * as pickerPreferences from "./model-picker-preferences.js";
import * as pickerState from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import * as interactionContext from "./native-command-context.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordNativeCommand,
} from "./native-command.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

// Keep transcript persistence outside this interaction boundary fixture.
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const THREAD = "100000000000000003";
const USER = "100000000000000004";
const DISABLED_CHANNEL = "100000000000000005";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(root);
    }
    cleanup();
  }),
);

function createConfig(): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: [`user:${USER}`] } },
    agents: { defaults: { model: { primary: "test-provider/test-model" } } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          [GUILD]: {
            channels: { [CHANNEL]: { enabled: true }, [DISABLED_CHANNEL]: { enabled: false } },
          },
        },
      },
    },
  };
}

function createHarness(
  cfg = createConfig(),
  dispatchReplyFromConfig?: Parameters<
    typeof createDiscordNativeCommand
  >[0]["dispatchReplyFromConfig"],
  threadBinding?: ThreadBindingRecord,
  pluginCommands: readonly PluginCommandNativeCandidate[] = [],
) {
  let currentConfig = cfg;
  vi.spyOn(runtimeConfig, "getRuntimeConfigSnapshot").mockImplementation(() => currentConfig);
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    accountId: "default",
    token: "test-token",
    readConfig: () => currentConfig,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const baseContext = nativeCommandContext(cfg);
  const commandContext = {
    ...baseContext,
    threadBindings: {
      ...baseContext.threadBindings,
      getByThreadId: (threadId: string) => (threadId === THREAD ? threadBinding : undefined),
    },
    readPolicy,
    postApplySettleMs: 0,
    dispatchReplyFromConfig,
  };
  const client = createInternalTestClient([
    ...pluginCommands.map((command) =>
      createDiscordNativeCommand({ ...commandContext, ephemeralDefault: true, command }),
    ),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "help", description: "Help", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "new", description: "New session", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "status", description: "Status", acceptsArgs: false },
    }),
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: {
        name: "boundary-choice",
        description: "Choose",
        acceptsArgs: true,
        args: [
          {
            name: "choice",
            description: "Choice",
            type: "string",
            preferAutocomplete: true,
            choices: ({ model }) => [model ?? "unresolved"],
          },
        ],
      },
    }),
  ]);
  client.componentHandler.register(createDiscordModelPickerFallbackButton(commandContext));
  const post = vi.fn(async () => undefined);
  const get = vi.fn(async (path: string) => {
    if (path === `/channels/${THREAD}`) {
      return { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL, name: "topic" };
    }
    if (path === `/channels/${CHANNEL}`) {
      return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
    }
    throw new Error(`Unexpected Discord GET ${path}`);
  });
  const patch = vi.fn(async () => undefined);
  attachRestMock(client, { post, get, patch });
  const session = vi.spyOn(sessionStore, "getSessionEntryAsync").mockResolvedValue(undefined);
  vi.spyOn(pickerState, "loadDiscordModelPickerData").mockResolvedValue(
    createModelsProviderData({ "test-provider": ["test-model"] }),
  );
  vi.spyOn(pickerPreferences, "readDiscordModelPickerRecentModels").mockResolvedValue([]);
  const dispatch = vi
    .spyOn(channelInbound, "dispatchChannelInboundTurn")
    .mockImplementation(async () => {
      throw new Error("Unexpected agent turn");
    });
  const status = vi
    .spyOn(commandStatus, "resolveDirectStatusReplyForSession")
    .mockImplementation(async ({ sessionKey }) => ({ text: `Status for ${sessionKey}` }));
  const context = vi.spyOn(interactionContext, "buildDiscordNativeInteractionContext");
  return {
    client,
    post,
    get,
    status,
    context,
    dispatch,
    session,
    patch,
    replaceConfig: (next: OpenClawConfig) => {
      currentConfig = next;
    },
    replacePolicy: () => {
      currentConfig = {
        ...cfg,
        channels: { discord: { groupPolicy: "disabled" } },
      };
    },
  };
}

function expectFollowUp(harness: ReturnType<typeof createHarness>, content: string) {
  expect(harness.post).toHaveBeenCalledWith(
    "/webhooks/app1/test-token",
    { body: { content, flags: 64 } },
    undefined,
  );
}

function expectAutocomplete(
  harness: ReturnType<typeof createHarness>,
  choices: { name: string; value: string }[] = [],
) {
  expect(harness.post).toHaveBeenCalledExactlyOnceWith(
    "/interactions/interaction1/test-token/callback",
    {
      body: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices },
      },
    },
  );
  if (choices.length === 0) {
    expect(harness.session).not.toHaveBeenCalled();
  }
}

function denyThreadParent(harness: ReturnType<typeof createHarness>, parentId = "denied") {
  harness.get.mockResolvedValue({
    id: THREAD,
    type: ChannelType.PublicThread,
    parent_id: parentId,
    name: "topic",
  });
}

// REST is controlled; construction, access policy, routing and serialization are real.
type Surface = "status" | "autocomplete" | "picker";
function interactionFor(
  surface: Surface,
  channelId: string,
  userId = USER,
  action: "back" | "reset" = "back",
) {
  const raw = createInternalInteractionPayload({
    id: "interaction1",
    token: "test-token",
    guild_id: GUILD,
    channel_id: channelId,
    member: {
      user: { id: userId, username: "tester", discriminator: "0", avatar: null, global_name: null },
      roles: [],
      joined_at: "2026-01-01T00:00:00.000Z",
      deaf: false,
      mute: false,
      permissions: "0",
      flags: GuildMemberFlags.CompletedOnboarding,
    },
    data: { id: "command1", name: "status", type: 1 },
  });
  if (surface === "status") {
    return raw;
  }
  if (surface === "picker") {
    return createInternalComponentInteractionPayload({
      ...raw,
      data: {
        custom_id: pickerState.buildDiscordModelPickerCustomId({
          command: "model",
          action,
          view: "providers",
          userId,
        }),
      },
    });
  }
  return createInternalInteractionPayload({
    ...raw,
    type: InteractionType.ApplicationCommandAutocomplete,
    data: {
      id: "command2",
      name: "boundary-choice",
      type: 1,
      options: [
        { name: "choice", type: ApplicationCommandOptionType.String, value: "", focused: true },
      ],
    },
  });
}

let harness: ReturnType<typeof createHarness>;
beforeEach(() => {
  clearDiscordChannelInfoCacheForTest();
  harness = createHarness();
});
afterEach(() => vi.restoreAllMocks());

it.for(["allowed", "denied", "revoked-command", "revoked-channel"] as const)(
  "handles an archived native command source (%s)",
  async (access) => {
    const storePath = join(tempDirs.make("openclaw-discord-archived-"), "sessions.json");
    const cfg: OpenClawConfig = {
      ...createConfig(),
      commands: { allowFrom: { discord: [USER] } },
      session: { store: storePath },
    };
    const denyCommands = (config: OpenClawConfig): OpenClawConfig => ({
      ...config,
      commands: { allowFrom: { discord: ["100000000000000005"] } },
    });
    const initialConfig = access === "denied" ? denyCommands(cfg) : cfg;
    const source = { storePath, sessionKey: `agent:main:discord:slash:${USER}` };
    const target = { storePath, sessionKey: `agent:main:discord:channel:${CHANNEL}` };
    const sessionId = "archived-command-session";
    await sessionStore.upsertSessionEntry({ ...source, entry: { sessionId, updatedAt: 1 } });
    await appendSessionTranscriptMessageByIdentity({
      ...source,
      sessionId,
      message: { role: "user", content: "Synthetic archived history", timestamp: 1 },
    });
    const archive = {
      archivedAt: 2,
      archivedBy: { type: "human" as const, id: "test-operator" },
      archiveReason: "manual" as const,
    };
    await sessionStore.patchSessionEntry({ ...source, update: () => archive });
    await sessionStore.upsertSessionEntry({
      ...target,
      entry: { sessionId: "active-channel-session", updatedAt: Date.now() },
    });
    const originalTarget = sessionStore.getSessionEntry(target);
    expect(sessionStore.getSessionEntry(source)).toMatchObject({ sessionId, archivedAt: 2 });
    const transcript = sessionStore.loadTranscriptEventsSync({ ...source, sessionId });
    expect(JSON.stringify(transcript)).toContain("Synthetic archived history");
    const restoreEntered = createDeferred<void>();
    const releaseRestore = createDeferred<void>();
    const revoking = access.startsWith("revoked-");
    const commandName = access === "allowed" ? "help" : "new";
    harness = createHarness(initialConfig, (params) =>
      getDiscordRuntime().channel.reply.dispatchReplyFromConfig({
        ...params,
        sessionWorkerPlacementContext: {
          workerSessionPlacementService: {
            getMany: () => new Map(),
            getManyAsync: async () => {
              if (revoking) {
                restoreEntered.resolve();
                await releaseRestore.promise;
              }
              return new Map();
            },
          },
        },
      }),
    );
    harness.dispatch.mockRestore();
    harness.session.mockRestore();
    await withRegisteredChannelIngress(
      { plugin: discordPlugin, config: initialConfig, setRuntime: setDiscordRuntime },
      async () => {
        const pending = harness.client.handleInteraction(
          createInternalInteractionPayload({
            ...interactionFor("status", CHANNEL),
            id: `archive-${access}`,
            type: InteractionType.ApplicationCommand,
            data: { id: "archive-command", name: commandName, type: 1 },
          }),
        );
        const completion = revoking
          ? expect(pending).rejects.toThrow("Discord command authority changed")
          : pending;
        if (revoking) {
          try {
            await Promise.race([
              restoreEntered.promise,
              pending.then(() => {
                throw new Error("Command finished without entering archive restoration");
              }),
            ]);
            expect(sessionStore.getSessionEntry(source)?.archivedAt).toBe(2);
            if (access === "revoked-command") {
              harness.replaceConfig(denyCommands(cfg));
            } else {
              harness.replacePolicy();
            }
          } finally {
            releaseRestore.resolve();
          }
        }
        await completion;
      },
    );
    const after = sessionStore.getSessionEntry(source);
    expect(after?.sessionId).toBe(sessionId);
    if (access === "allowed") {
      expectFollowUp(harness, expect.stringContaining("Help"));
      expect([after?.archivedAt, after?.archivedBy, after?.archiveReason]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } else {
      if (access === "denied") {
        expectFollowUp(harness, expect.stringContaining("not authorized"));
      }
      expect(after).toMatchObject(archive);
      expect(harness.post).not.toHaveBeenCalledWith(
        "/webhooks/app1/test-token",
        { body: { content: expect.stringContaining("Help"), flags: 64 } },
        undefined,
      );
      expect(sessionStore.getSessionEntry(target)).toEqual(originalTarget);
    }
    expect(sessionStore.loadTranscriptEventsSync({ ...source, sessionId })).toEqual(transcript);
  },
);

it.each<Surface>(["status", "autocomplete", "picker"])(
  "routes raw thread %s without hydration",
  async (surface) => {
    await harness.client.handleInteraction(interactionFor(surface, THREAD));
    const sessionKey = `agent:main:discord:channel:${THREAD}`;
    if (surface === "status") {
      expectFollowUp(harness, `Status for ${sessionKey}`);
    } else {
      expect(harness.session).toHaveBeenCalledWith(expect.objectContaining({ sessionKey }));
      if (surface === "autocomplete") {
        expectAutocomplete(harness, [{ name: "test-model", value: "test-model" }]);
      } else {
        expect(JSON.stringify(harness.patch.mock.calls)).toContain("test-provider");
      }
    }
  },
);

it("rejects status for a thread whose parent is outside the allowlist", async () => {
  denyThreadParent(harness);
  await harness.client.handleInteraction(interactionFor("status", THREAD));
  expect(harness.status).not.toHaveBeenCalled();
  expectFollowUp(harness, "This channel is not allowed.");
});

it.each<[Surface, "sender" | "parent" | "identity"]>([
  ["autocomplete", "sender"],
  ["autocomplete", "parent"],
  ["picker", "sender"],
  ["picker", "parent"],
  ["picker", "identity"],
])("denies raw %s with denied %s", async (surface, denial) => {
  const interaction = interactionFor(
    surface,
    denial === "parent" ? THREAD : CHANNEL,
    denial === "sender" ? "100000000000000099" : USER,
    "reset",
  );
  if (denial === "parent") {
    denyThreadParent(harness);
  }
  if (denial === "identity") {
    Reflect.deleteProperty(interaction, "channel_id");
  }
  await harness.client.handleInteraction(interaction);
  if (surface === "autocomplete") {
    expectAutocomplete(harness);
  } else {
    expect(harness.dispatch).not.toHaveBeenCalled();
    expect(JSON.stringify(harness.post.mock.calls)).toContain(
      "Failed to apply test-provider/test-model",
    );
    expect(JSON.stringify(harness.post.mock.calls)).toContain(
      denial === "sender" ? "not authorized" : "not allowed",
    );
  }
});

it.each<Surface>(["status", "autocomplete", "picker"])(
  "denies raw %s when policy changes during the channel fetch",
  async (surface) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    harness.get.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
    });
    const pending = harness.client.handleInteraction(
      interactionFor(surface, CHANNEL, USER, "reset"),
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => true), pending.then(() => false)]),
      ).toBe(true);
      harness.replacePolicy();
    } finally {
      release.resolve();
      await pending;
    }
    expect(harness.status).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
    if (surface === "autocomplete") {
      expectAutocomplete(harness);
    } else if (surface === "status") {
      expectFollowUp(harness, "Access policy changed. Try this interaction again.");
    } else {
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        "Failed to apply test-provider/test-model",
      );
    }
  },
);

// The record a `/codex bind` plus Allow once writes for a thread: an opaque plugin
// session key, with the plugin named as the owner in metadata.
function createPluginOwnedThreadBinding(): ThreadBindingRecord {
  return {
    accountId: "default",
    channelId: CHANNEL,
    threadId: THREAD,
    targetKind: "acp",
    targetSessionKey: "plugin-binding:codex:d9d55822716ec2ce6dd262cd",
    agentId: "main",
    boundBy: USER,
    boundAt: 1,
    lastActivityAt: 1,
    metadata: {
      pluginBindingOwner: "plugin",
      pluginId: "codex",
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
    },
  };
}

describe("plugin-bound thread", () => {
  // The session an unbound thread resolves to; the raw thread cases above pin it.
  const sessionKey = `agent:main:discord:channel:${THREAD}`;
  const codexHandler = vi.fn(async (ctx: { sessionKey?: string }) => ({
    text: `codex:${ctx.sessionKey ?? ""}`,
  }));

  // The plugin command registry is global: register `codex` per case and reset it after.
  beforeEach(() => {
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
    codexHandler.mockClear();
    expect(
      registerPluginCommand(
        "codex",
        {
          name: "codex",
          description: "Codex",
          acceptsArgs: true,
          requireAuth: true,
          handler: async (ctx) => await codexHandler(ctx),
        },
        { allowReservedCommandNames: true },
      ),
    ).toEqual({ ok: true });
    harness = createPluginBoundHarness(createPluginOwnedThreadBinding());
  });
  afterEach(() => {
    clearPluginCommands();
    setActivePluginRegistry(createTestRegistry());
  });

  function createPluginBoundHarness(threadBinding: ThreadBindingRecord, cfg?: OpenClawConfig) {
    return createHarness(
      cfg,
      undefined,
      threadBinding,
      createPluginCommandRuntime().listNativeCandidates("discord"),
    );
  }

  function codexBindingInteraction() {
    return createInternalInteractionPayload({
      ...interactionFor("status", THREAD),
      type: InteractionType.ApplicationCommand,
      data: {
        id: "command1",
        name: "codex",
        type: 1,
        options: [{ name: "input", type: ApplicationCommandOptionType.String, value: "binding" }],
      },
    });
  }

  it("uses the non-default channel route for status and the plugin command agent", async () => {
    const cfg = createConfig();
    cfg.agents = { ...cfg.agents, ownership: "explicit", entries: { main: {}, work: {} } };
    cfg.bindings = [
      { agentId: "work", match: { channel: "discord", peer: { kind: "channel", id: CHANNEL } } },
    ];
    harness = createPluginBoundHarness(createPluginOwnedThreadBinding(), cfg);
    const routedSessionKey = `agent:work:discord:channel:${THREAD}`;
    await harness.client.handleInteraction(interactionFor("status", THREAD));
    expect(harness.status).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey: routedSessionKey }),
    );
    expectFollowUp(harness, `Status for ${routedSessionKey}`);

    await harness.client.handleInteraction(codexBindingInteraction());
    expect(codexHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "work", sessionKey: routedSessionKey, args: "binding" }),
    );
    expect(harness.session).toHaveBeenCalledWith({
      agentId: "work",
      sessionKey: routedSessionKey,
    });
    expectFollowUp(harness, `codex:${routedSessionKey}`);
    expect(recordDeliveredCommandExchange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "work",
        sessionKey: routedSessionKey,
        replyId: "plugin-reply",
      }),
    );
  });

  it("keeps the refusal when an agent-owned record and its session agent disagree", async () => {
    // Do not turn an existing ownership mismatch into an admitted plugin command.
    const boundSessionKey = "agent:work:subagent:bound";
    harness = createPluginBoundHarness({
      ...createPluginOwnedThreadBinding(),
      targetKind: "subagent",
      targetSessionKey: boundSessionKey,
      agentId: "main",
      metadata: {},
    });
    await harness.client.handleInteraction(codexBindingInteraction());
    expect(codexHandler).not.toHaveBeenCalled();
    expect(harness.session).toHaveBeenCalledWith({ agentId: "main", sessionKey: boundSessionKey });
    expectFollowUp(harness, "⚠️ Command failed. Please try again later.");
  });

  it("routes native /status to the thread session", async () => {
    await harness.client.handleInteraction(interactionFor("status", THREAD));
    expect(harness.status).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey, channel: "discord", senderId: USER }),
    );
    expectFollowUp(harness, `Status for ${sessionKey}`);
  });

  it("hands native /codex binding to the plugin command", async () => {
    await harness.client.handleInteraction(
      createInternalInteractionPayload({
        ...interactionFor("status", THREAD),
        type: InteractionType.ApplicationCommand,
        data: {
          id: "command1",
          name: "codex",
          type: 1,
          options: [{ name: "input", type: ApplicationCommandOptionType.String, value: "binding" }],
        },
      }),
    );
    expect(codexHandler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        args: "binding",
        agentId: "main",
        sessionKey,
        channel: "discord",
        from: `discord:channel:${THREAD}`,
        messageThreadId: THREAD,
        threadParentId: CHANNEL,
      }),
    );
    expect(harness.status).not.toHaveBeenCalled();
    expectFollowUp(harness, `codex:${sessionKey}`);
  });

  it("keeps the disabled-parent denial for native /new", async () => {
    denyThreadParent(harness, DISABLED_CHANNEL);
    await harness.client.handleInteraction(
      createInternalInteractionPayload({
        ...interactionFor("status", THREAD),
        type: InteractionType.ApplicationCommand,
        data: { id: "command1", name: "new", type: 1 },
      }),
    );
    expect(harness.context).not.toHaveBeenCalled();
    expect(harness.dispatch).not.toHaveBeenCalled();
    expectFollowUp(harness, "This channel is disabled.");
  });
});

installDiscordIngressTestRuntime();
