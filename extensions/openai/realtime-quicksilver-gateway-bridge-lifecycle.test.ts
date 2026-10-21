import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, vi } from "vitest";
import { delegation, turn } from "./realtime-quicksilver-events.test-support.js";
import {
  createAudioPeer,
  createGatewayHarness,
  type GatewayConfig,
} from "./realtime-quicksilver-gateway.test-support.js";
import {
  createCallResponse,
  emitSideband,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

function createBridge(
  params: Pick<
    GatewayConfig,
    "runAgentConsult" | "onError" | "onTranscript" | "handleDelegationInput"
  >,
) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    createCallResponse("v=answer\r\n", "rtc_lifecycle"),
  );
  const createPeer = vi.fn(async () => createAudioPeer());
  const harness = createGatewayHarness({
    model: "gpt-live-test",
    voice: "marin",
    audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
    ...params,
    resolveAuth: async () => ({ type: "api-key", token: "platform-key" }),
    createPeer,
    fetchImpl,
    startSession: { expires_at: Math.floor(Date.now() / 1000) + 60 },
  });
  return { ...harness, createPeer, fetchImpl };
}

describe("OpenAI Quicksilver gateway bridge lifecycle", () => {
  it("reports recoverable provider errors to the relay while preserving its connection", async () => {
    const onError = vi.fn();
    const onTranscript = vi.fn();
    const harness = createBridge({
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      onError,
      onTranscript,
    });
    try {
      await harness.bridge.connect();
      const socket = harness.getSocket();
      emitSideband(socket, { type: "error", error: { message: "temporary voice failure" } });
      emitSideband(socket, turn("assistant", "Recovered"));

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "OpenAI GPT-Live provider error" }),
      );
      expect(onTranscript).toHaveBeenCalledWith("assistant", "Recovered", true);
      expect(harness.bridge.isConnected()).toBe(true);
    } finally {
      await harness.bridge.close();
    }
  });

  it("aborts an accepted delegation when the bridge closes normally", async () => {
    let consultSignal: AbortSignal | undefined;
    const runAgentConsult = vi.fn(async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
      consultSignal = signal;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { text: "must not be delivered" };
    });
    const harness = createBridge({ runAgentConsult });

    await harness.bridge.connect();
    const socket = harness.getSocket();
    emitSideband(socket, delegation("delegation-abort", "Cancel this on close"));
    await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());

    await harness.bridge.close();
    expect(consultSignal?.aborted).toBe(true);
    await Promise.resolve();
    expect(parseSent(socket).filter((event) => event.type === "delegation.context.append")).toEqual(
      [],
    );
  });

  it.each([false, true])(
    "detaches transport without aborting an accepted delegation (classified=%s)",
    async (classified) => {
      let consultSignal: AbortSignal | undefined;
      const { promise: consultResult, resolve: resolveConsult } = createDeferred<{
        text: string;
      }>();
      const runAgentConsult = vi.fn(
        async ({ signal }: { prompt: string; signal?: AbortSignal }) => {
          consultSignal = signal;
          return await consultResult;
        },
      );
      const harness = createBridge({
        runAgentConsult,
        handleDelegationInput: classified ? () => "consult" : undefined,
      });

      try {
        await harness.bridge.connect();
        const socket = harness.getSocket();
        expect(parseSent(socket)[0]).toMatchObject({
          type: "session.update",
          session: { delegation: { type: "client", ack_filler: false } },
        });
        expect(harness.fetchImpl).not.toHaveBeenCalled();
        expect(harness.createPeer).not.toHaveBeenCalled();
        emitSideband(socket, delegation("delegation-detach", "Finish after disconnect"));
        await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
        expect(
          parseSent(socket).filter((event) => event.type === "session.context.append"),
        ).toHaveLength(classified ? 1 : 0);

        await harness.bridge.close({ disposition: "detach" });
        const sentAtClose = socket.sent.length;
        emitSideband(socket, delegation("late", "Do not acknowledge after detach"));
        expect(consultSignal?.aborted).toBe(false);
        resolveConsult({ text: "finished after detach" });
        await nextEventLoopTurn();
        expect(
          parseSent(socket).filter((event) => event.type === "delegation.context.append"),
        ).toEqual([]);
        expect(socket.sent).toHaveLength(sentAtClose);
        expect(runAgentConsult).toHaveBeenCalledOnce();
      } finally {
        resolveConsult({ text: "Finished" });
        await harness.bridge.close();
      }
    },
  );
});
