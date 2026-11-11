import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as plugins from "openclaw/plugin-sdk/plugin-test-runtime";
import * as configSnapshot from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionBindings from "openclaw/plugin-sdk/session-binding-runtime";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "openclaw/plugin-sdk/system-event-runtime";
import { resetSystemEventsForTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MatrixConfigSchema } from "../../config-schema.js";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import type { CoreConfig, MatrixConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixReactionEvent as makeReaction,
  createMatrixReactionTestHarness as createReactionHarness,
  createMatrixTextMessageEvent as textMessage,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

const roomId = "!room:example.org";
const botUserId = "@bot:example.org";
const rootBody = "Discussion started by the bot";
const strict = { requireMentionInBotThreads: true } satisfies MatrixConfig;
const relaxed = { requireMentionInBotThreads: false } satisfies MatrixConfig;
beforeEach(() => installMatrixMonitorTestRuntime());

describe("Matrix bot-owned thread mention policy", () => {
  function setup(matrix: MatrixConfig = {}) {
    expect(MatrixConfigSchema.parse(matrix)).toEqual(matrix);
    const cfg: CoreConfig = { channels: { matrix } };
    const accountConfig = resolveMatrixAccountConfig({ cfg, accountId: "work" });
    const root = textMessage({ eventId: "$root", sender: botUserId, body: rootBody });
    const getEvent = vi.fn(async () => root);
    const dispatch = vi.fn(async () => ({
      queuedFinal: false,
      counts: { final: 0, block: 0, tool: 0 },
    }));
    const harness = createHarness({
      cfg,
      accountId: "work",
      accountConfig,
      roomsConfig: accountConfig.groups ?? accountConfig.rooms,
      groupPolicy: accountConfig.groupPolicy ?? "open",
      isDirectMessage: false,
      client: { getEvent },
      dispatchInboundMessage: dispatch,
    });
    return {
      ...harness,
      root,
      getEvent,
      dispatch,
      receive: (overrides: Partial<Parameters<typeof textMessage>[0]> = {}) =>
        harness.handler(
          roomId,
          textMessage({
            eventId: "$followup",
            body: "Continue the discussion",
            relatesTo: { rel_type: "m.thread", event_id: "$root" },
            ...overrides,
          }),
        ),
    };
  }

  it.each<[string, MatrixConfig]>([
    ["account", { ...strict, accounts: { work: relaxed } }],
    ["exact group", { groups: { "*": strict, [roomId]: relaxed } }],
  ])("accepts unmentioned bot-thread replies with %s configuration", async (_scope, config) => {
    const f = setup(config);
    await f.receive();
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(vi.mocked(f.recordInboundSession).mock.calls[0]?.[0]).toMatchObject({
      ctx: {
        BodyForAgent: "Continue the discussion",
        ThreadStarterBody: expect.stringContaining(rootBody),
      },
    });
  });

  it("retains mention gating when bot-thread policy explicitly requires it", async () => {
    const f = setup({ ...strict, rooms: { [roomId]: { autoReply: true } } });
    await f.receive();
    expect(f.dispatch).not.toHaveBeenCalled();

    await f.receive({
      eventId: "$mentioned",
      body: `${botUserId} Continue the discussion`,
      mentions: { user_ids: [botUserId] },
    });
    expect(f.dispatch).toHaveBeenCalledOnce();
  });

  it.each<[string, Partial<MatrixRawEvent> | null, number]>([
    ["another author's root", { sender: "@other:example.org" }, 0],
    ["another event id", { event_id: "$other" }, 0],
    ["another room", { room_id: "!other:example.org" }, 0],
    ["an unreadable root", null, 0],
    ["a redacted bot-authored root", { content: {}, unsigned: { redacted_because: {} } }, 1],
  ])("applies bot-thread ownership gating to %s", async (_kind, patch, dispatches) => {
    const f = setup(relaxed);
    if (patch) {
      f.getEvent.mockResolvedValue({ ...f.root, ...patch });
    } else {
      f.getEvent.mockRejectedValue(new Error("M_FORBIDDEN"));
    }
    await f.receive();
    expect(f.dispatch).toHaveBeenCalledTimes(dispatches);
  });

  it.each<[string, MatrixConfig]>([
    ["disabled rooms", { groupPolicy: "disabled" }],
    ["room sender allowlists", { rooms: { [roomId]: { users: ["@trusted:example.org"] } } }],
  ])("preserves %s inside bot threads", async (_restriction, config) => {
    const f = setup({ ...config, ...relaxed });
    await f.receive();
    expect(f.dispatch).not.toHaveBeenCalled();
    expect(f.getEvent).not.toHaveBeenCalled();
  });
});

describe("Matrix reaction ownership", () => {
  const reactionEvent = (eventId: string) =>
    makeReaction({ eventId, targetEventId: "$msg1", key: "👍" });
  beforeEach(() => {
    resetSystemEventsForTest();
    sessionBindings.testing.resetSessionBindingAdaptersForTests();
  });
  afterEach(() => {
    resetSystemEventsForTest();
    configSnapshot.clearRuntimeConfigSnapshot();
    sessionBindings.testing.resetSessionBindingAdaptersForTests();
  });

  it("keeps a reaction on the runtime-bound global owner's queue", async () => {
    const cfg = {
      agents: { entries: { main: {}, research: {} } },
      bindings: [{ agentId: "main", match: { channel: "matrix", accountId: "ops" } }],
      channels: { matrix: { dm: { allowFrom: ["*"] } } },
    };
    configSnapshot.setRuntimeConfigSnapshot(cfg);
    const binding = {
      bindingId: "reaction-owner",
      targetSessionKey: "global",
      targetKind: "session" as const,
      conversation: { channel: "matrix", accountId: "ops", conversationId: roomId },
      status: "active" as const,
      boundAt: 1,
      metadata: { agentId: "research" },
    };
    sessionBindings.registerSessionBindingAdapter({
      ...binding.conversation,
      listBySession: () => [binding],
      resolveByConversation: () => binding,
    });
    const { handler, runPrepared } = createReactionHarness({ cfg });
    await handler(roomId, reactionEvent("$owner-reaction"));
    expect(peekSystemEventEntries("agent:research:global")).toHaveLength(1);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
    expect(binding.targetSessionKey).toBe("global");
    expect(runPrepared).not.toHaveBeenCalled();
  });

  it("rejects an already-running reaction after its runtime is revoked", async () => {
    const cfg = { channels: { matrix: { dm: { allowFrom: ["*"] } } } };
    const builder = plugins.createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: plugins.createPluginRuntimeMock({ system: { enqueueSystemEvent } }),
      activateGlobalSideEffects: false,
    });
    const record = plugins.createPluginRecord({ id: "matrix", origin: "bundled" });
    const api = builder.createApi(record, { config: cfg });
    builder.registry.plugins.push(record);
    const targetLookup = createDeferred<void>();
    const targetEvent = textMessage({ eventId: "$msg1", sender: "@bot:example.org", body: "" });
    const target = createDeferred<typeof targetEvent>();
    const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() };
    const { handler } = createHarness({
      cfg,
      runtime,
      system: api.runtime.system,
      client: {
        getEvent: async () => {
          targetLookup.resolve();
          return await target.promise;
        },
      },
    });
    const reaction = handler(roomId, reactionEvent("$revoked-reaction"));
    try {
      await targetLookup.promise;
      builder.rollbackPluginGlobalSideEffects(record.id, record);
      target.resolve(targetEvent);
      await expect(reaction).rejects.toThrow('Plugin "matrix" runtime is no longer active');

      expect(peekSystemEventEntries("agent:ops:main")).toEqual([]);
      expect(runtime.error).toHaveBeenCalled();
    } finally {
      target.resolve(targetEvent);
      await reaction.catch(() => undefined);
      await plugins.disposePluginRegistryInstances(builder.registry);
    }
  });
});
