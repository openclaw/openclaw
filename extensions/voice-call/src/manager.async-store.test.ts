import fs from "node:fs";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import { createTestStorePath, FakeProvider, makePersistedCall } from "./manager.test-harness.js";
import { CALL_RECORD_EVENTS_NAMESPACE, findCallInStore } from "./manager/store.js";
import * as callStore from "./manager/store.js";
import { setVoiceCallStateRuntime } from "./runtime-state.js";
import { CallRecordSchema, type InitiateCallInput } from "./types.js";
import { RealtimeCallHandler } from "./webhook/realtime-handler.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "./websocket-test-support.js";
import type { WebSocket } from "./websocket.js";

async function withDelayedStore(
  run: (fixture: {
    manager: CallManager;
    config: VoiceCallConfig;
    provider: FakeProvider;
    storePath: string;
    holdNextWrite: () => {
      entered: Promise<void>;
      release: () => void;
      fail: () => void;
    };
  }) => Promise<void>,
  fixtureOptions: { initialize?: boolean; provider?: FakeProvider; realtime?: boolean } = {},
) {
  const storePath = createTestStorePath();
  const writes: Promise<void>[] = [];
  const persist = callStore.persistCallRecord;
  const persistence = vi.spyOn(callStore, "persistCallRecord").mockImplementation((...args) => {
    const work = persist(...args);
    writes.push(work);
    return work;
  });
  const gates: ReturnType<typeof createDeferred<void>>[] = [];
  let nextWrite: (() => Promise<void>) | undefined;
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => storePath,
      openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
        const store = createPluginStateKeyedStoreForTests<T>("voice-call", options);
        return {
          ...store,
          async register(...args: Parameters<typeof store.register>) {
            if (options.namespace === CALL_RECORD_EVENTS_NAMESPACE && nextWrite) {
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
  const config = VoiceCallConfigSchema.parse({
    provider: provider.name,
    realtime: { enabled: fixtureOptions.realtime ?? false },
    fromNumber: "+15550000000",
    maxConcurrentCalls: 1,
  });
  const manager = new CallManager(config, storePath);
  if (fixtureOptions.initialize !== false) {
    await manager.initialize(provider, "https://fixture.invalid/voice/webhook");
  }
  try {
    await run({
      manager,
      config,
      provider,
      storePath,
      holdNextWrite() {
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
    });
  } finally {
    for (const gate of gates) {
      gate.resolve();
    }
    await manager.stop();
    await Promise.allSettled(writes);
    persistence.mockRestore();
    resetPluginStateStoreForTests();
    fs.rmSync(storePath, { recursive: true, force: true });
  }
}

it("reserves pending capacity without publishing or dialing an uncommitted call", async () => {
  await withDelayedStore(async ({ manager, provider, holdNextWrite }) => {
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
});

it.each(["committed", "failed", "retired"] as const)(
  "waits for the outbound provider binding before admitting a token-bound stream (%s)",
  async (outcome) => {
    await withDelayedStore(
      async ({ manager, config, provider, storePath, holdNextWrite }) => {
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
          return {
            connect: async () => {},
            sendAudio: () => {},
            setMediaTimestamp: () => {},
            submitToolResult: () => {},
            acknowledgeMark: () => {},
            close: () => {},
            isConnected: () => true,
            triggerGreeting: () => {},
          };
        });
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
          { connect: () => {}, disconnect: () => {}, retire: () => {} },
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
          await handler.close();
          await server?.close();
          await placement;
          await retirement;
          initiate.mockRestore();
        }
      },
      { provider: new FakeProvider("telnyx"), realtime: true },
    );
  },
);

it("keeps failed event drafts private and admits a duplicate only after rollback", async () => {
  await withDelayedStore(async ({ manager, storePath, holdNextWrite }) => {
    const placement = await manager.initiateCall("+15550000001");
    const call = manager.getCall(placement.callId)!;
    const gate = holdNextWrite();
    const event = {
      id: "answered-replay",
      type: "call.answered" as const,
      callId: call.callId,
      providerCallId: call.providerCallId,
      timestamp: Date.now(),
    };
    const first = manager.processEvent(event);
    void first.catch(() => {});
    await gate.entered;
    const second = manager.processEvent({ ...event });
    expect(manager.getCall(call.callId) === call).toBe(true);
    expect(call.state).toBe("initiated");
    expect(call.answeredAt).toBeUndefined();
    expect(call.processedEventIds).not.toContain(event.id);
    gate.fail();
    await expect(first).rejects.toThrow("Synthetic delayed persistence failure");
    await expect(second).resolves.toMatchObject({ kind: "processed" });
    expect(manager.getCall(call.callId) === call).toBe(true);
    expect(call.state).toBe("answered");
    expect(call.processedEventIds.filter((id) => id === event.id)).toHaveLength(1);
    resetPluginStateStoreForTests();
    expect((await findCallInStore(storePath, call.callId))?.state).toBe("answered");
  });
});

it("drains an admitted event on stop without starting late playback or accepting new events", async () => {
  await withDelayedStore(async ({ manager, provider, storePath, holdNextWrite }) => {
    const placement = await manager.initiateCall("+15550000001", undefined, {
      mode: "notify",
      message: "Synthetic notification",
    });
    const call = manager.getCall(placement.callId)!;
    const gate = holdNextWrite();
    const event = manager.processEvent({
      id: "stop-during-answered",
      type: "call.answered",
      callId: call.callId,
      providerCallId: call.providerCallId,
      timestamp: Date.now(),
    });
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
    expect((await findCallInStore(storePath, call.callId))?.state).toBe("answered");
  });
});

it("does not hang up a rejected inbound call after stop begins during persistence", async () => {
  await withDelayedStore(async ({ manager, provider, holdNextWrite }) => {
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
});

it("joins admitted restore checks without starting carrier work after a delayed expiry write", async () => {
  await withDelayedStore(
    async ({ manager, provider, storePath, holdNextWrite }) => {
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restored-active",
            providerCallId: "provider-active",
            startedAt: Date.now(),
          }),
        ),
      );
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restored-expired",
            providerCallId: "provider-expired",
            startedAt: Date.now() - 400_000,
          }),
        ),
      );
      const status = createDeferred<{ isTerminal: boolean; status: string }>();
      vi.spyOn(provider, "getCallStatus").mockImplementation(() => status.promise);
      const gate = holdNextWrite();
      const initialization = manager.initialize(provider, "https://fixture.invalid/voice/webhook");
      await gate.entered;
      let stopped = false;
      const stopping = manager.stop().then(() => {
        stopped = true;
      });
      gate.release();
      try {
        await expect
          .poll(async () => (await findCallInStore(storePath, "restored-expired"))?.state)
          .toBe("timeout");
        expect(stopped).toBe(false);
        expect(provider.hangupCalls).toHaveLength(0);
      } finally {
        status.resolve({ isTerminal: false, status: "in-progress" });
      }
      await initialization;
      await stopping;
      expect(provider.hangupCalls).toHaveLength(0);
      expect((await findCallInStore(storePath, "restored-expired"))?.state).toBe("timeout");
    },
    { initialize: false },
  );
});

it("publishes restored calls only after their missing live anchor is persisted", async () => {
  await withDelayedStore(
    async ({ manager, provider, storePath, holdNextWrite }) => {
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restored-unanchored",
            providerCallId: "provider-unanchored",
            startedAt: Date.now(),
            answeredAt: undefined,
            state: "speaking",
          }),
        ),
      );
      const gate = holdNextWrite();
      const initialization = manager.initialize(provider, "https://fixture.invalid/voice/webhook");
      try {
        await gate.entered;
        expect(manager.getActiveCalls()).toHaveLength(0);
        expect(manager.getCallByProviderCallId("provider-unanchored")).toBeUndefined();
      } finally {
        gate.release();
        await initialization;
      }
      expect(manager.getActiveCalls()).toHaveLength(1);
      expect((await findCallInStore(storePath, "restored-unanchored"))?.answeredAt).toBeTypeOf(
        "number",
      );
    },
    { initialize: false },
  );
});

it("rejects restore when terminal-state persistence fails instead of reporting a provider failure", async () => {
  await withDelayedStore(
    async ({ manager, provider, storePath, holdNextWrite }) => {
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restored-terminal",
            providerCallId: "provider-terminal",
            startedAt: Date.now(),
          }),
        ),
      );
      provider.getCallStatusResult = { isTerminal: true, status: "completed" };
      const gate = holdNextWrite();
      const initialization = manager.initialize(provider, "https://fixture.invalid/voice/webhook");
      void initialization.catch(() => {});
      await gate.entered;
      gate.fail();
      await expect(initialization).rejects.toThrow("Synthetic delayed persistence failure");
      expect(manager.getActiveCalls()).toHaveLength(0);
      expect((await findCallInStore(storePath, "restored-terminal"))?.state).toBe("answered");
    },
    { initialize: false },
  );
});

it("observes restore write failures while awaiting another carrier", async () => {
  await withDelayedStore(
    async ({ manager, provider, storePath }) => {
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restore-terminal-first",
            providerCallId: "provider-terminal-first",
            startedAt: Date.now(),
          }),
        ),
      );
      await callStore.persistCallRecord(
        storePath,
        CallRecordSchema.parse(
          makePersistedCall({
            callId: "restore-expired-second",
            providerCallId: "provider-expired-second",
            startedAt: Date.now() - 400_000,
          }),
        ),
      );
      const persist = expectDefined(
        vi.mocked(callStore.persistCallRecord).getMockImplementation(),
        "native persistence observer",
      );
      vi.mocked(callStore.persistCallRecord).mockImplementation((directory, call) =>
        call.callId === "restore-terminal-first" && call.state === "completed"
          ? Promise.reject(new Error("Synthetic terminal write failed"))
          : persist(directory, call),
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
      const initialization = manager.initialize(provider, "https://fixture.invalid/voice/webhook");
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
        } finally {
          process.off("unhandledRejection", capture);
        }
      }
    },
    { initialize: false },
  );
});
