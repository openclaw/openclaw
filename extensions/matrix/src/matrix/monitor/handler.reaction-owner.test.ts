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
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness as createHarness,
  createMatrixReactionEvent as makeReaction,
  createMatrixReactionTestHarness as createReactionHarness,
  createMatrixTextMessageEvent as textMessage,
} from "./handler.test-helpers.js";

const roomId = "!room:example.org";
const reactionEvent = (eventId: string) =>
  makeReaction({ eventId, targetEventId: "$msg1", key: "👍" });
beforeEach(() => {
  installMatrixMonitorTestRuntime();
  resetSystemEventsForTest();
  sessionBindings.testing.resetSessionBindingAdaptersForTests();
});
afterEach(() => {
  resetSystemEventsForTest();
  configSnapshot.clearRuntimeConfigSnapshot();
  sessionBindings.testing.resetSessionBindingAdaptersForTests();
});

describe("Matrix reaction ownership", () => {
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
    const { handler, recordInboundSession, runPrepared } = createReactionHarness({ cfg });
    await handler(roomId, reactionEvent("$owner-reaction"));
    expect(peekSystemEventEntries("agent:research:global")).toEqual([
      expect.objectContaining({ text: "Matrix reaction added: 👍 by sender on msg $msg1" }),
    ]);
    expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
    expect(binding.targetSessionKey).toBe("global");
    expect(recordInboundSession).not.toHaveBeenCalled();
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
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining('Plugin "matrix" runtime is no longer active'),
      );
    } finally {
      target.resolve(targetEvent);
      await reaction.catch(() => undefined);
      await plugins.disposePluginRegistryInstances(builder.registry);
    }
  });
});
