import { join } from "node:path";
import {
  ApplicationCommandOptionType,
  ChannelType,
  GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
} from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import {
  loadSessionWorktreeLifecycleForTest,
  withRegisteredChannelIngress,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import * as commandStatus from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as runtimeConfig from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
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
import { setDiscordRuntime } from "../runtime.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordLivePolicyReader } from "./live-policy.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import * as pickerPreferences from "./model-picker-preferences.js";
import * as pickerState from "./model-picker.state.js";
import { createModelsProviderData } from "./model-picker.test-utils.js";
import {
  createDiscordModelPickerFallbackButton,
  createDiscordNativeCommand,
} from "./native-command.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const GUILD = "100000000000000001";
const CHANNEL = "100000000000000002";
const THREAD = "100000000000000003";
const USER = "100000000000000004";

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
    commands: { allowFrom: { discord: [USER] } },
    agents: { defaults: { model: { primary: "test-provider/test-model" } } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: { [GUILD]: { channels: { [CHANNEL]: { enabled: true } } } },
      },
    },
  };
}

function createHarness(cfg = createConfig()) {
  let currentConfig = cfg;
  vi.spyOn(runtimeConfig, "getRuntimeConfigSnapshot").mockImplementation(() => currentConfig);
  const readPolicy = createDiscordLivePolicyReader({
    cfg,
    accountId: "default",
    token: "test-token",
    readConfig: () => currentConfig,
    resolvedAllowlist: { guildEntries: cfg.channels?.discord?.guilds, allowFrom: [] },
  });
  const commandContext = {
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    readPolicy,
    accountId: "default",
    sessionPrefix: "discord:slash",
    postApplySettleMs: 0,
    threadBindings: createNoopThreadBindingManager("default"),
  };
  const client = createInternalTestClient([
    createDiscordNativeCommand({
      ...commandContext,
      ephemeralDefault: true,
      command: { name: "compact", description: "Compact", acceptsArgs: false },
    }),
    ...["new", "reset"].map((name) =>
      createDiscordNativeCommand({
        ...commandContext,
        ephemeralDefault: true,
        command: { name, description: "Start a fresh session", acceptsArgs: false },
      }),
    ),
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
  const post = vi.fn(
    async (_path: string, _params: { body?: Record<string, unknown> }, _auth?: unknown) =>
      undefined,
  );
  const get = vi.fn(async (path: string) => {
    if (path === `/channels/${THREAD}`) {
      return { id: THREAD, type: ChannelType.PublicThread, parent_id: CHANNEL, name: "topic" };
    }
    if (path === `/channels/${CHANNEL}`) {
      return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
    }
    throw new Error(`Unexpected Discord GET ${path}`);
  });
  const patch = vi.fn(
    async (_path: string, _params: { body?: Record<string, unknown> }, _auth?: unknown) =>
      undefined,
  );
  attachRestMock(client, { post, get, patch });
  const session = vi.spyOn(sessionStore, "getSessionEntry").mockReturnValue(undefined);
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
  return {
    client,
    post,
    get,
    status,
    dispatch,
    session,
    patch,
    replacePolicy: () => {
      currentConfig = {
        ...cfg,
        channels: { discord: { groupPolicy: "disabled" } },
      };
    },
  };
}

function payload(channelId: string, hydrated = false, userId = USER) {
  return createInternalInteractionPayload({
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
    ...(hydrated ? { channel: { id: channelId, type: ChannelType.GuildText } } : {}),
    data: { id: "command1", name: "status", type: 1 },
  });
}

function autocompletePayload(channelId: string, hydrated = false, userId = USER) {
  return createInternalInteractionPayload({
    ...payload(channelId, hydrated, userId),
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

function pickerPayload(channelId: string, action: "back" | "reset" = "back", userId = USER) {
  return createInternalComponentInteractionPayload({
    ...payload(channelId, false, userId),
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

function expectFollowUp(harness: ReturnType<typeof createHarness>, content: string) {
  expect(harness.post).toHaveBeenCalledWith(
    "/webhooks/app1/test-token",
    { body: { content, flags: 64 } },
    undefined,
  );
}

function expectEmptyAutocomplete(harness: ReturnType<typeof createHarness>) {
  expect(harness.post).toHaveBeenCalledExactlyOnceWith(
    "/interactions/interaction1/test-token/callback",
    {
      body: {
        type: InteractionResponseType.ApplicationCommandAutocompleteResult,
        data: { choices: [] },
      },
    },
  );
  expect(harness.session).not.toHaveBeenCalled();
}

function denyThreadParent(harness: ReturnType<typeof createHarness>) {
  harness.get.mockResolvedValue({
    id: THREAD,
    type: ChannelType.PublicThread,
    parent_id: "denied",
    name: "topic",
  });
}

function expectVisibleStatus(harness: ReturnType<typeof createHarness>, channelId: string) {
  const sessionKey = `agent:main:discord:channel:${channelId}`;
  expect(harness.status, JSON.stringify(harness.post.mock.calls)).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionKey, channel: "discord", senderId: USER, isGroup: true }),
  );
  expectFollowUp(harness, `Status for ${sessionKey}`);
}

// Isolated boundary proof: REST is controlled; interaction construction, dispatch,
// access policy, conversation routing and response serialization are production code.
describe("Client.handleInteraction native command channel identity", () => {
  beforeEach(() => clearDiscordChannelInfoCacheForTest());
  afterEach(() => vi.restoreAllMocks());

  it("restores an archived slash source and runs compact without replacing its history", async () => {
    const storePath = join(tempDirs.make("openclaw-discord-archived-"), "sessions.json");
    const cfg: OpenClawConfig = { ...createConfig(), session: { store: storePath } };
    const source = { storePath, sessionKey: `agent:main:discord:slash:${USER}` };
    const target = { storePath, sessionKey: `agent:main:discord:channel:${CHANNEL}` };
    const sessionId = "archived-command-session";
    await sessionStore.upsertSessionEntry({
      ...source,
      entry: { sessionId, updatedAt: 1 },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...source,
      sessionId,
      message: { role: "user", content: "Synthetic archived history", timestamp: 1 },
    });
    await sessionStore.patchSessionEntry({
      ...source,
      update: () => ({ archivedAt: 2, archivedBy: { type: "human", id: "test-operator" } }),
    });
    await sessionStore.upsertSessionEntry({
      ...target,
      entry: { sessionId: "active-channel-session", updatedAt: Date.now() },
    });
    const activeTarget = sessionStore.getSessionEntry(target);
    expect(activeTarget).toMatchObject({ sessionId: "active-channel-session" });
    expect(activeTarget?.archivedAt).toBeUndefined();
    const archived = sessionStore.getSessionEntry(source);
    if (!archived) {
      throw new Error("Expected the archived command session fixture to exist");
    }
    expect(archived).toMatchObject({ sessionId, archivedAt: 2 });
    const transcript = sessionStore.loadTranscriptEventsSync({ ...source, sessionId });
    expect(JSON.stringify(transcript)).toContain("Synthetic archived history");
    const harness = createHarness(cfg);
    harness.dispatch.mockRestore();
    harness.session.mockRestore();
    await withRegisteredChannelIngress(
      { plugin: discordPlugin, config: cfg, setRuntime: setDiscordRuntime },
      async () => {
        await harness.client.handleInteraction(
          createInternalInteractionPayload({
            ...payload(CHANNEL),
            id: "archived-compact",
            type: InteractionType.ApplicationCommand,
            data: { id: "compact-command", name: "compact", type: 1 },
          }),
        );
      },
    );
    expect(harness.post).toHaveBeenCalledWith(
      "/interactions/archived-compact/test-token/callback",
      {
        body: {
          type: InteractionResponseType.DeferredChannelMessageWithSource,
          data: { flags: 64 },
        },
      },
    );
    const replies = [...harness.post.mock.calls, ...harness.patch.mock.calls]
      .map((call) => call[1]?.body)
      .filter((body) => body && "content" in body);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ content: expect.stringContaining("Compaction") });
    const after = sessionStore.getSessionEntry(source);
    expect(after).toMatchObject({
      sessionId: archived.sessionId,
    });
    expect(after?.archivedAt).toBeUndefined();
    expect(after?.archivedBy).toBeUndefined();
    expect(after?.archiveReason).toBeUndefined();
    expect(sessionStore.loadTranscriptEventsSync({ ...source, sessionId })).toEqual(transcript);
    expect(sessionStore.getSessionEntry(target)?.sessionId).toBe(activeTarget?.sessionId);
    expect(sessionStore.getSessionEntry(target)?.archivedAt).toBeUndefined();
  });

  it.each([
    { command: "new", sourceState: "archived" },
    { command: "reset", sourceState: "active" },
    { command: "new", sourceState: "missing" },
  ] as const)(
    "runs /$command for an archived conversation with a $sourceState command source",
    async ({ command, sourceState }) => {
      const storePath = join(tempDirs.make("openclaw-discord-archived-reset-"), "sessions.json");
      const cfg: OpenClawConfig = { ...createConfig(), session: { store: storePath } };
      const source = { storePath, sessionKey: `agent:main:discord:slash:${USER}` };
      const target = { storePath, sessionKey: `agent:main:discord:channel:${CHANNEL}` };
      if (sourceState !== "missing") {
        await sessionStore.upsertSessionEntry({
          ...source,
          entry: { sessionId: "command-source", updatedAt: Date.now() },
        });
        if (sourceState === "archived") {
          await sessionStore.patchSessionEntry({ ...source, update: () => ({ archivedAt: 2 }) });
        }
      }
      await sessionStore.upsertSessionEntry({
        ...target,
        entry: {
          sessionId: "previous-conversation",
          lifecycleRevision: "previous-generation",
          updatedAt: Date.now(),
          totalTokens: 100,
          compactionCount: 3,
        },
      });
      await appendSessionTranscriptMessageByIdentity({
        ...target,
        sessionId: "previous-conversation",
        message: { role: "user", content: "Retain this conversation history", timestamp: 1 },
      });
      const previousHistory = sessionStore.loadTranscriptEventsSync({
        ...target,
        sessionId: "previous-conversation",
      });
      await sessionStore.patchSessionEntry({
        ...target,
        update: () => ({ archivedAt: 2, archivedBy: { type: "human", id: "test-operator" } }),
      });
      const harness = createHarness(cfg);
      harness.dispatch.mockRestore();
      harness.session.mockRestore();
      await withRegisteredChannelIngress(
        { plugin: discordPlugin, config: cfg, setRuntime: setDiscordRuntime },
        () =>
          harness.client.handleInteraction(
            createInternalInteractionPayload({
              ...payload(CHANNEL),
              id: `archived-${command}-${sourceState}`,
              type: InteractionType.ApplicationCommand,
              data: { id: "reset-command", name: command, type: 1 },
            }),
          ),
      );
      const replies = [...harness.post.mock.calls, ...harness.patch.mock.calls]
        .map((call) => call[1]?.body)
        .filter((body) => body && "content" in body);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toMatchObject({
        content: command === "new" ? "✅ New session started." : "✅ Session reset.",
      });
      const after = sessionStore.getSessionEntry(target);
      expect(after?.archivedAt).toBeUndefined();
      expect(after?.sessionId).toBe("previous-conversation");
      expect(after?.lifecycleRevision).toBeTruthy();
      expect(after?.lifecycleRevision).not.toBe("previous-generation");
      expect(after).toMatchObject({ totalTokens: 0, compactionCount: 0 });
      const afterHistory = sessionStore.loadTranscriptEventsSync({
        ...target,
        sessionId: "previous-conversation",
      });
      expect(afterHistory.slice(0, previousHistory.length)).toEqual(previousHistory);
      expect(afterHistory.slice(previousHistory.length)).toEqual([
        expect.objectContaining({ type: "reset", reason: command }),
      ]);
      if (sourceState !== "missing") {
        expect(sessionStore.getSessionEntry(source)).toMatchObject({ sessionId: "command-source" });
        expect(sessionStore.getSessionEntry(source)?.archivedAt).toBeUndefined();
      }
    },
  );

  it.each(["source", "reset target"] as const)(
    "refuses archived %s recovery after live command policy revocation",
    async (held) => {
      const root = tempDirs.make("openclaw-discord-revoked-archive-");
      const storePath = join(root, "sessions.json");
      const cfg: OpenClawConfig = { ...createConfig(), session: { store: storePath } };
      const source = { storePath, sessionKey: `agent:main:discord:slash:${USER}` };
      const target = { storePath, sessionKey: `agent:main:discord:channel:${CHANNEL}` };
      const sourceId = "retained-hidden-history";
      const targetId = "retained-conversation-history";
      await sessionStore.upsertSessionEntry({
        ...source,
        entry: {
          sessionId: sourceId,
          updatedAt: 1,
          ...(held === "source"
            ? {
                archivedAt: 2,
                worktree: { id: "held-source", branch: "test", repoRoot: root },
              }
            : {}),
        },
      });
      await sessionStore.upsertSessionEntry({
        ...target,
        entry: {
          sessionId: targetId,
          updatedAt: 1,
          ...(held === "reset target"
            ? {
                archivedAt: 2,
                worktree: { id: "held-target", branch: "test", repoRoot: root },
              }
            : {}),
        },
      });
      for (const [scope, sessionId] of [
        [source, sourceId],
        [target, targetId],
      ] as const) {
        await appendSessionTranscriptMessageByIdentity({
          ...scope,
          sessionId,
          message: { role: "user", content: `Keep ${sessionId}`, timestamp: 1 },
        });
      }
      const beforeSource = sessionStore.getSessionEntry(source);
      const beforeTarget = sessionStore.getSessionEntry(target);
      const sourceHistory = sessionStore.loadTranscriptEventsSync({
        ...source,
        sessionId: sourceId,
      });
      const targetHistory = sessionStore.loadTranscriptEventsSync({
        ...target,
        sessionId: targetId,
      });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const worktreeLifecycle = await loadSessionWorktreeLifecycleForTest();
      vi.spyOn(worktreeLifecycle, "restoreSessionWorktree").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return () => {};
      });
      const harness = createHarness(cfg);
      harness.dispatch.mockRestore();
      harness.session.mockRestore();
      const pending = withRegisteredChannelIngress(
        { plugin: discordPlugin, config: cfg, setRuntime: setDiscordRuntime },
        () =>
          harness.client.handleInteraction(
            createInternalInteractionPayload({
              ...payload(CHANNEL),
              id: `revoked-archive-${held}`,
              type: InteractionType.ApplicationCommand,
              data: {
                id: "revoked-command",
                name: held === "source" ? "compact" : "reset",
                type: 1,
              },
            }),
          ),
      );
      try {
        await entered.promise;
        harness.replacePolicy();
      } finally {
        release.resolve();
      }
      await expect(pending).rejects.toThrow("Discord command authority changed");
      expect(sessionStore.getSessionEntry(source)).toMatchObject({
        sessionId: beforeSource?.sessionId,
      });
      expect(sessionStore.getSessionEntry(target)).toMatchObject({
        sessionId: beforeTarget?.sessionId,
      });
      expect(sessionStore.getSessionEntry(source)?.archivedAt).toBe(beforeSource?.archivedAt);
      expect(sessionStore.getSessionEntry(target)?.archivedAt).toBe(beforeTarget?.archivedAt);
      expect(sessionStore.loadTranscriptEventsSync({ ...source, sessionId: sourceId })).toEqual(
        sourceHistory,
      );
      expect(sessionStore.loadTranscriptEventsSync({ ...target, sessionId: targetId })).toEqual(
        targetHistory,
      );
    },
  );

  it.each(["non-reset command", "unauthorized reset"] as const)(
    "does not restore archived sessions for a %s",
    async (scenario) => {
      const storePath = join(tempDirs.make("openclaw-discord-archive-denied-"), "sessions.json");
      const cfg: OpenClawConfig = { ...createConfig(), session: { store: storePath } };
      const userId = scenario === "unauthorized reset" ? "100000000000000099" : USER;
      const source = { storePath, sessionKey: `agent:main:discord:slash:${userId}` };
      const target = { storePath, sessionKey: `agent:main:discord:channel:${CHANNEL}` };
      for (const [scope, sessionId] of [
        [source, "source"],
        [target, "target"],
      ] as const) {
        await sessionStore.upsertSessionEntry({
          ...scope,
          entry: { sessionId, updatedAt: 1, archivedAt: 2 },
        });
      }
      const beforeSource = sessionStore.getSessionEntry(source);
      const beforeTarget = sessionStore.getSessionEntry(target);
      const harness = createHarness(cfg);
      harness.dispatch.mockRestore();
      harness.session.mockRestore();
      const run = () =>
        withRegisteredChannelIngress(
          { plugin: discordPlugin, config: cfg, setRuntime: setDiscordRuntime },
          () =>
            harness.client.handleInteraction(
              createInternalInteractionPayload({
                ...payload(CHANNEL, false, userId),
                id: `archive-denied-${scenario}`,
                type: InteractionType.ApplicationCommand,
                data: {
                  id: "denied-command",
                  name: scenario === "unauthorized reset" ? "new" : "compact",
                  type: 1,
                },
              }),
            ),
        );
      if (scenario === "unauthorized reset") {
        await run();
        expectFollowUp(harness, "You are not authorized to use this command.");
      } else {
        await expect(run()).rejects.toThrow("is archived");
        const replies = [...harness.post.mock.calls, ...harness.patch.mock.calls]
          .map((call) => call[1]?.body)
          .filter((body) => body && "content" in body);
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({
          content:
            "Command failed. Please retry. If this conversation is archived, use /new or /reset to start again. If it still fails, ask an operator to check the Gateway logs.",
        });
      }
      if (scenario === "unauthorized reset") {
        expect(sessionStore.getSessionEntry(source)).toEqual(beforeSource);
        expect(sessionStore.getSessionEntry(target)).toEqual(beforeTarget);
      } else {
        // Authorized ingress may stamp routing metadata; it must not reopen either session.
        for (const [scope, before] of [
          [source, beforeSource],
          [target, beforeTarget],
        ] as const) {
          const after = sessionStore.getSessionEntry(scope);
          expect(after).toMatchObject({
            sessionId: before?.sessionId,
            archivedAt: before?.archivedAt,
          });
          expect(after?.lifecycleRevision).toBe(before?.lifecycleRevision);
          expect(after?.archivedBy).toEqual(before?.archivedBy);
          expect(after?.archiveReason).toBe(before?.archiveReason);
        }
      }
    },
  );

  it.each([THREAD])("delivers status for raw channel %s without hydration", async (channelId) => {
    const harness = createHarness();
    await harness.client.handleInteraction(payload(channelId));
    expectVisibleStatus(harness, channelId);
  });

  it("rejects a thread whose parent is outside the allowlist", async () => {
    const harness = createHarness();
    denyThreadParent(harness);
    await harness.client.handleInteraction(payload(THREAD));
    expect(harness.status).not.toHaveBeenCalled();
    expectFollowUp(harness, "This channel is not allowed.");
  });

  it.each([THREAD])(
    "autocompletes for raw channel %s through the registered option",
    async (channelId) => {
      const harness = createHarness();
      await harness.client.handleInteraction(autocompletePayload(channelId));
      expect(harness.post).toHaveBeenCalledWith("/interactions/interaction1/test-token/callback", {
        body: {
          type: InteractionResponseType.ApplicationCommandAutocompleteResult,
          data: { choices: [{ name: "test-model", value: "test-model" }] },
        },
      });
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
    },
  );

  it.each([THREAD])(
    "opens the registered picker for the raw channel %s session",
    async (channelId) => {
      const harness = createHarness();
      await harness.client.handleInteraction(pickerPayload(channelId));
      expect(harness.session).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: `agent:main:discord:channel:${channelId}`,
        }),
      );
      expect(harness.patch).toHaveBeenCalledWith(
        "/webhooks/app1/test-token/messages/%40original",
        expect.objectContaining({
          body: expect.objectContaining({ components: expect.any(Array) }),
        }),
        expect.anything(),
      );
      expect(JSON.stringify(harness.patch.mock.calls)).toContain("test-provider");
    },
  );

  it.each(["sender", "parent"] as const)(
    "denies raw autocomplete with denied %s",
    async (denial) => {
      const harness = createHarness();
      const interaction = autocompletePayload(
        denial === "parent" ? THREAD : CHANNEL,
        false,
        denial === "sender" ? "100000000000000099" : USER,
      );
      if (denial === "parent") {
        denyThreadParent(harness);
      }
      await harness.client.handleInteraction(interaction);
      expectEmptyAutocomplete(harness);
    },
  );

  it.each(["sender", "parent", "identity"] as const)(
    "denies raw picker selection with denied %s",
    async (denial) => {
      const harness = createHarness();
      const interaction = pickerPayload(
        denial === "parent" ? THREAD : CHANNEL,
        "reset",
        denial === "sender" ? "100000000000000099" : USER,
      );
      if (denial === "parent") {
        denyThreadParent(harness);
      }
      if (denial === "identity") {
        Reflect.deleteProperty(interaction, "channel_id");
      }
      await harness.client.handleInteraction(interaction);
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        "Failed to apply test-provider/test-model",
      );
      expect(JSON.stringify(harness.post.mock.calls)).toContain(
        denial === "sender" ? "not authorized" : "not allowed",
      );
    },
  );

  it.each(["status", "autocomplete", "picker"] as const)(
    "denies raw %s when policy changes during the channel fetch",
    async (surface) => {
      const harness = createHarness();
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      harness.get.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { id: CHANNEL, type: ChannelType.GuildText, name: "allowed" };
      });
      const interaction =
        surface === "status"
          ? payload(CHANNEL)
          : surface === "autocomplete"
            ? autocompletePayload(CHANNEL)
            : pickerPayload(CHANNEL, "reset");
      const pending = harness.client.handleInteraction(interaction);
      try {
        const fetched = await Promise.race([
          entered.promise.then(() => true),
          pending.then(() => false),
        ]);
        expect(fetched).toBe(true);
        harness.replacePolicy();
      } finally {
        release.resolve();
        await pending;
      }
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.dispatch).not.toHaveBeenCalled();
      if (surface === "autocomplete") {
        expectEmptyAutocomplete(harness);
      } else if (surface === "status") {
        expectFollowUp(harness, "Access policy changed. Try this interaction again.");
      } else {
        expect(JSON.stringify(harness.post.mock.calls)).toContain(
          "Failed to apply test-provider/test-model",
        );
      }
    },
  );
});

installDiscordIngressTestRuntime();
