import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createVoiceCallServiceContext, registerVoiceCall } from "../index.test-harness.js";
import { normalizeVoiceCallConfig, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import { createTestStorePath, FakeProvider, makePersistedCall } from "./manager.test-harness.js";
import { findCallInStore } from "./manager/store.js";
import * as callStore from "./manager/store.js";
import { setVoiceCallStateRuntime } from "./runtime-state.js";
import type { VoiceCallRuntime } from "./runtime.js";
import { CallRecordSchema, type CallRecord, type InitiateCallInput } from "./types.js";
import { makeBridge } from "./webhook/realtime-call-control.test-helpers.js";
import { speakOnRealtimeBridge } from "./webhook/realtime-call-session-control.js";
import { RealtimeCallHandler } from "./webhook/realtime-handler.js";
import { StreamDisconnectGrace } from "./webhook/stream-disconnect-grace.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";

let registeredRuntime: VoiceCallRuntime;

// mock-isolation: Keep telephony startup outside these registered-boundary manager tests.
vi.mock("../runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => registeredRuntime),
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const persistCallRecord = callStore.persistCallRecord;
const fixtureCleanups: (() => Promise<void>)[] = [];
// Drain managers before onTestFinished retires registered services and temp stores.
afterEach(async () => {
  for (const cleanup of fixtureCleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function registerSteeringTool(runtime: VoiceCallRuntime, requesterSessionKey: string) {
  registeredRuntime = runtime;
  const serviceContext = createVoiceCallServiceContext({ stateDir: "", logger });
  const { service, toolFactory } = registerVoiceCall({
    config: {
      provider: "mock",
      inboundPolicy: "allowlist",
      realtime: { enabled: true },
    },
    logger,
  });
  void service.start(serviceContext);
  onTestFinished(async () => {
    await service?.stop?.(serviceContext);
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });
  return toolFactory({ sessionKey: requesterSessionKey });
}

async function prepareSteering(
  manager: CallManager,
  config: VoiceCallConfig,
  requester = "agent:main:owner",
) {
  const { callId } = await manager.initiateCall("+15550002222", undefined, {
    message: "Book a table",
    mode: "conversation",
    requesterSessionKey: "agent:main:owner",
  });
  const triggerGreeting = vi.fn();
  const bridges = new Map([[callId, { triggerGreeting }]]);
  const runtime = {
    config,
    manager,
    webhookServer: {
      speakRealtime: (id: string, instructions: string) =>
        speakOnRealtimeBridge(bridges, id, instructions),
    },
    stop: vi.fn(async () => {}),
  } as unknown as VoiceCallRuntime;
  return { callId, triggerGreeting, tool: registerSteeringTool(runtime, requester) };
}

async function createDelayedStore(
  fixtureOptions: { initialize?: boolean; provider?: FakeProvider; realtime?: boolean } = {},
) {
  const storePath = createTestStorePath();
  const writes: Promise<void>[] = [];
  const persistence = vi.spyOn(callStore, "persistCallRecord").mockImplementation((...args) => {
    const work = persistCallRecord(...args);
    writes.push(work);
    return work;
  });
  const gates: ReturnType<typeof createDeferred<void>>[] = [];
  let nextWrite: (() => Promise<void>) | undefined;
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => storePath,
      openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) => {
        const store = createPluginStateKeyedStoreV2ForTests<T>("voice-call", options, {
          assertCurrent() {},
        });
        return {
          ...store,
          async register(...args: Parameters<typeof store.register>) {
            if (options.namespace === "call-record-events" && nextWrite) {
              const hold = nextWrite;
              nextWrite = undefined;
              await hold();
            }
            await store.register(...args);
          },
        };
      },
      openChannelIngressQueue: () => {
        throw new Error("Unused ingress queue");
      },
      openChannelIngressDrain: () => {
        throw new Error("Unused ingress drain");
      },
    },
  });
  const provider = fixtureOptions.provider ?? new FakeProvider();
  const config = normalizeVoiceCallConfig({
    provider: provider.name,
    realtime: { enabled: fixtureOptions.realtime ?? false },
    fromNumber: "+15550000000",
    maxConcurrentCalls: 1,
  });
  const manager = new CallManager(config, storePath);
  fixtureCleanups.push(async () => {
    for (const gate of gates) {
      gate.resolve();
    }
    await manager.stop();
    await Promise.allSettled(writes);
    persistence.mockRestore();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
  });
  const initialize = () => manager.initialize(provider, "https://fixture.invalid/voice/webhook");
  if (fixtureOptions.initialize !== false) {
    await initialize();
  }
  return {
    manager,
    config,
    provider,
    storePath,
    initialize,
    read: (callId: string) => findCallInStore(storePath, callId),
    persist: (callId: string, providerCallId: string, overrides = {}) =>
      callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId,
            providerCallId,
            startedAt: Date.now(),
            ...overrides,
          }),
        ),
      ),
    holdNextWrite(this: void) {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      gates.push(release);
      let fail = false;
      nextWrite = async () => {
        entered.resolve();
        await release.promise;
        if (fail) {
          throw new Error("Synthetic delayed persistence failure");
        }
      };
      return {
        entered: entered.promise,
        release: () => release.resolve(),
        fail: () => {
          fail = true;
          release.resolve();
        },
      };
    },
  };
}

function answeredEvent(call: CallRecord, id: string) {
  return {
    id,
    type: "call.answered" as const,
    callId: call.callId,
    providerCallId: call.providerCallId,
    timestamp: Date.now(),
  };
}

it("reserves pending capacity without publishing or dialing an uncommitted call", async () => {
  const { manager, provider, holdNextWrite } = await createDelayedStore();
  const dial = vi.spyOn(provider, "initiateCall");
  const gate = holdNextWrite();
  const first = manager.initiateCall("+15550000001");
  void first.catch(() => {});
  await gate.entered;
  expect(manager.getActiveCalls()).toHaveLength(0);
  expect(dial).not.toHaveBeenCalled();
  await expect(manager.initiateCall("+15550000002")).resolves.toMatchObject({
    success: false,
    error: "Maximum concurrent calls (1) reached",
  });
  gate.fail();
  await expect(first).rejects.toThrow("Synthetic delayed persistence failure");
  expect(manager.getActiveCalls()).toHaveLength(0);
  await expect(manager.initiateCall("+15550000002")).resolves.toMatchObject({ success: true });
  expect(dial).toHaveBeenCalledOnce();
});

it.each(["foreign", "revoked", "allowed"] as const)(
  "checks registered steering admission and effects (%s)",
  async (admission) => {
    const { manager, config, provider, read, holdNextWrite } = await createDelayedStore({
      realtime: true,
    });
    const requester = admission === "foreign" ? "agent:main:stranger" : "agent:main:owner";
    const { callId, tool, triggerGreeting } = await prepareSteering(manager, config, requester);
    const turn = new AbortController();
    const gate = admission === "revoked" ? holdNextWrite() : undefined;
    const message = admission === "allowed" ? "Ask for a written quote" : "Promise a refund";
    const pending = tool.execute(admission, { action: "steer_call", callId, message }, turn.signal);
    if (gate) {
      await gate.entered;
      turn.abort(new Error("Requester turn ended"));
      gate.release();
    }
    const result = JSON.stringify(await pending);
    expect(result).toContain(
      {
        foreign: "requester",
        revoked: "Requester turn ended",
        allowed: '"success":true',
      }[admission],
    );
    const instructions = admission === "allowed" ? [message] : undefined;
    expect(manager.getCall(callId)?.metadata?.ownerInstructions).toEqual(instructions);
    if (admission === "revoked") {
      resetPluginStateStoreForTests();
    }
    expect((await read(callId))?.metadata?.ownerInstructions).toEqual(instructions);
    if (admission === "allowed") {
      expect(triggerGreeting).toHaveBeenCalledOnce();
      expect(triggerGreeting.mock.calls[0]?.[0]).toContain(message);
    } else {
      expect(triggerGreeting).not.toHaveBeenCalled();
    }
    expect(provider.playTtsCalls).toEqual([]);
  },
);

it.each(["committed", "failed", "retired"] as const)(
  "waits for the outbound provider binding before admitting a token-bound stream (%s)",
  async (outcome) => {
    const { manager, config, provider, storePath, holdNextWrite } = await createDelayedStore({
      provider: new FakeProvider("telnyx"),
      realtime: true,
    });
    const providerCallId = "native-provider-binding";
    const dialed = createDeferred<InitiateCallInput>();
    const bridgeCreated = createDeferred<void>();
    const frameReceived = createDeferred<void>();
    let bindingWrite: ReturnType<typeof holdNextWrite> | undefined;
    const initiate = vi.spyOn(provider, "initiateCall").mockImplementation(async (input) => {
      bindingWrite = holdNextWrite();
      dialed.resolve(input);
      return { providerCallId, status: "initiated" };
    });
    const createBridge = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>(() => {
      bridgeCreated.resolve();
      return makeBridge({ submitToolResult: () => {} });
    });
    const streamDisconnectLifecycle = new StreamDisconnectGrace(() => {});
    const handler = new RealtimeCallHandler(
      config.realtime,
      manager,
      () => ({
        agentId: "main",
        instructions: "Synthetic realtime fixture.",
        provider: {
          id: "test-realtime",
          label: "Test realtime",
          isConfigured: () => true,
          createBridge,
        },
        providerConfig: {},
      }),
      config.serve.path,
      streamDisconnectLifecycle,
    );
    manager.streamSessionIssuer = (request) => handler.issueStreamSession(request);
    let server: Awaited<ReturnType<typeof startUpgradeWsServer>> | undefined;
    let ws: WebSocket | undefined;
    const placement = manager.initiateCall("+15550000001", undefined, { mode: "conversation" });
    let retirement: ReturnType<CallManager["processEvent"]> | undefined;
    try {
      const input = await dialed.promise;
      const write = expectDefined(bindingWrite, "pending provider binding write");
      await write.entered;
      expect(manager.getCall(input.callId)?.providerCallId).toBeUndefined();
      if (outcome === "retired") {
        retirement = manager.processEvent({
          id: "terminal-before-stream-admission",
          type: "call.ended",
          callId: input.callId,
          providerCallId,
          timestamp: Date.now(),
          reason: "hangup-user",
        });
      }
      server = await startUpgradeWsServer({
        urlPath: new URL(expectDefined(input.streamUrl, "issued Telnyx stream URL")).pathname,
        onUpgrade: (request, socket, head) => {
          socket.once("data", () => frameReceived.resolve());
          handler.handleWebSocketUpgrade(request, socket, head);
        },
      });
      ws = await connectWs(server.url);
      const closed = waitForClose(ws);
      const admitted = Promise.race([
        bridgeCreated.promise.then(() => "bridge" as const),
        closed.then(() => "closed" as const),
      ]);
      ws.send(
        JSON.stringify({
          event: "start",
          stream_id: "native-binding-stream",
          start: { call_control_id: providerCallId },
        }),
      );
      await frameReceived.promise;
      expect(createBridge).not.toHaveBeenCalled();
      if (outcome === "failed") {
        write.fail();
      } else {
        write.release();
      }
      expect((await placement).success).toBe(outcome !== "failed");
      await retirement;
      expect(await admitted).toBe(outcome === "committed" ? "bridge" : "closed");
      if (outcome === "committed") {
        expect(createBridge).toHaveBeenCalledOnce();
        expect((await findCallInStore(storePath, input.callId))?.providerCallId).toBe(
          providerCallId,
        );
      } else {
        expect(createBridge).not.toHaveBeenCalled();
        expect(manager.getCall(input.callId)).toBeUndefined();
      }
      ws.terminate();
      await closed;
    } finally {
      bindingWrite?.release();
      ws?.terminate();
      try {
        await handler.close();
        await server?.close();
      } finally {
        streamDisconnectLifecycle.close();
      }
      await placement;
      await retirement;
      initiate.mockRestore();
    }
  },
);

it("keeps failed event drafts private and admits a duplicate only after rollback", async () => {
  const { manager, read, holdNextWrite } = await createDelayedStore();
  const placement = await manager.initiateCall("+15550000001");
  const call = manager.getCall(placement.callId)!;
  const gate = holdNextWrite();
  const event = answeredEvent(call, "answered-replay");
  const first = manager.processEvent(event);
  void first.catch(() => {});
  await gate.entered;
  const second = manager.processEvent({ ...event });
  expect(manager.getCall(call.callId)).toBe(call);
  expect(call.state).toBe("initiated");
  expect(call.answeredAt).toBeUndefined();
  expect(call.processedEventIds).not.toContain(event.id);
  gate.fail();
  await expect(first).rejects.toThrow("Synthetic delayed persistence failure");
  await expect(second).resolves.toMatchObject({ kind: "processed" });
  expect(manager.getCall(call.callId)).toBe(call);
  expect(call.state).toBe("answered");
  expect(call.processedEventIds.filter((id) => id === event.id)).toHaveLength(1);
  resetPluginStateStoreForTests();
  expect((await read(call.callId))?.state).toBe("answered");
});

it("drains an admitted event on stop without starting late playback or accepting new events", async () => {
  const { manager, provider, read, holdNextWrite } = await createDelayedStore();
  const placement = await manager.initiateCall("+15550000001", undefined, {
    mode: "notify",
    message: "Synthetic notification",
  });
  const call = manager.getCall(placement.callId)!;
  const gate = holdNextWrite();
  const event = manager.processEvent(answeredEvent(call, "stop-during-answered"));
  await gate.entered;
  let stopped = false;
  const stop = manager.stop().then(() => {
    stopped = true;
  });
  await expect(
    manager.processEvent({
      id: "late-event",
      type: "call.active",
      callId: call.callId,
      timestamp: Date.now(),
    }),
  ).rejects.toThrow("manager is stopping");
  expect(stopped).toBe(false);
  expect(provider.playTtsCalls).toHaveLength(0);
  gate.release();
  await event;
  await stop;
  expect(provider.playTtsCalls).toHaveLength(0);
  resetPluginStateStoreForTests();
  expect((await read(call.callId))?.state).toBe("answered");
});

it("does not hang up a rejected inbound call after stop begins during persistence", async () => {
  const { manager, provider, holdNextWrite } = await createDelayedStore();
  const gate = holdNextWrite();
  const event = manager.processEvent({
    id: "rejected-during-stop",
    type: "call.initiated",
    callId: "unknown-inbound",
    providerCallId: "provider-rejected",
    timestamp: Date.now(),
    direction: "inbound",
    from: "+15550000001",
    to: "+15550000000",
  });
  await gate.entered;
  const stopping = manager.stop();
  gate.release();
  await event;
  await stopping;
  expect(provider.hangupCalls).toHaveLength(0);
});

it("joins admitted restore checks without starting carrier work after a delayed expiry write", async () => {
  const { manager, provider, persist, read, initialize, holdNextWrite } = await createDelayedStore({
    initialize: false,
  });
  await persist("restored-active", "provider-active");
  await persist("restored-expired", "provider-expired", {
    startedAt: Date.now() - 400_000,
    answeredAt: Date.now() - 400_000,
  });
  const status = createDeferred<{ isTerminal: boolean; status: string }>();
  vi.spyOn(provider, "getCallStatus").mockImplementation(() => status.promise);
  const gate = holdNextWrite();
  const initialization = initialize();
  await gate.entered;
  let stopped = false;
  const stopping = manager.stop().then(() => {
    stopped = true;
  });
  gate.release();
  try {
    await expect.poll(async () => (await read("restored-expired"))?.state).toBe("timeout");
    expect(stopped).toBe(false);
    expect(provider.hangupCalls).toHaveLength(0);
  } finally {
    status.resolve({ isTerminal: false, status: "in-progress" });
  }
  await initialization;
  await stopping;
  expect(provider.hangupCalls).toHaveLength(0);
  expect((await read("restored-expired"))?.state).toBe("timeout");
});

it("publishes restored calls only after their missing live anchor is persisted", async () => {
  const { manager, persist, read, initialize, holdNextWrite } = await createDelayedStore({
    initialize: false,
  });
  await persist("restored-unanchored", "provider-unanchored", {
    startedAt: Date.now(),
    answeredAt: undefined,
    state: "speaking",
  });
  const gate = holdNextWrite();
  const initialization = initialize();
  try {
    await gate.entered;
    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(manager.getCallByProviderCallId("provider-unanchored")).toBeUndefined();
  } finally {
    gate.release();
    await initialization;
  }
  expect(manager.getActiveCalls()).toHaveLength(1);
  expect((await read("restored-unanchored"))?.answeredAt).toBeTypeOf("number");
});

it("observes restore write failures while awaiting another carrier", async () => {
  const { manager, provider, persist, read, initialize } = await createDelayedStore({
    initialize: false,
  });
  await persist("restore-terminal-first", "provider-terminal-first");
  await persist("restore-expired-second", "provider-expired-second", {
    startedAt: Date.now() - 400_000,
    answeredAt: Date.now() - 400_000,
  });
  const originalPersist = expectDefined(
    vi.mocked(callStore.persistCallRecord).getMockImplementation(),
    "native persistence observer",
  );
  vi.mocked(callStore.persistCallRecord).mockImplementation((directory, call) =>
    call.callId === "restore-terminal-first" && call.state === "completed"
      ? Promise.reject(new Error("Synthetic terminal write failed"))
      : originalPersist(directory, call),
  );
  provider.getCallStatusResult = { isTerminal: true, status: "completed" };
  const carrierStarted = createDeferred<void>();
  const releaseCarrier = createDeferred<void>();
  vi.spyOn(provider, "hangupCall").mockImplementation(async () => {
    carrierStarted.resolve();
    await releaseCarrier.promise;
  });
  const unhandled: unknown[] = [];
  const capture = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", capture);
  const initialization = initialize();
  void initialization.catch(() => {});
  try {
    await carrierStarted.promise;
    // Node reports unobserved rejections between event-loop turns, before the carrier resolves.
    await nextEventLoopTurn();
    expect(unhandled).toEqual([]);
  } finally {
    releaseCarrier.resolve();
    try {
      await expect(initialization).rejects.toThrow("Synthetic terminal write failed");
      expect(manager.getActiveCalls()).toHaveLength(0);
      expect((await read("restore-terminal-first"))?.state).toBe("answered");
    } finally {
      process.off("unhandledRejection", capture);
    }
  }
});
