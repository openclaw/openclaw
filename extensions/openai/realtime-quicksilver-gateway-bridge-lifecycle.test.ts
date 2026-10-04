import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { RealtimeVoiceBridgeCreateRequest } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import { fakeQuicksilverMediaSocket } from "./realtime-quicksilver-socket.test-support.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
  parseSent,
} from "./realtime-quicksilver.test-helpers.js";

function createBridge(params: {
  model?: string;
  runAgentConsult: (request: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  onError?: (error: Error) => void;
  onTranscript?: (role: "user" | "assistant", text: string, done: boolean) => void;
  onResponseDone?: RealtimeVoiceBridgeCreateRequest["onResponseDone"];
  handleDelegationInput?: (text: string) => "control" | "consult";
}) {
  let socket: FakeSocket | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    createCallResponse("v=answer\r\n", "rtc_lifecycle"),
  );
  const createPeer = vi.fn(async () => ({
    createOffer: vi.fn(async () => "v=offer\r\n"),
    applyAnswer: vi.fn(async () => undefined),
    adoptPendingAudio: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
  }));
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: params.model ?? "gpt-live-test",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError: params.onError,
      onTranscript: params.onTranscript,
      onResponseDone: params.onResponseDone,
      runAgentConsult: params.runAgentConsult,
      handleDelegationInput: params.handleDelegationInput,
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "api-key" as const,
        token: "platform-key",
      })),
      createPeer,
      fetchImpl,
      mediaSocketFactory: fakeQuicksilverMediaSocket(() => {
        socket = new FakeSocket();
        const send = socket.send.bind(socket);
        socket.send = (payload) => {
          send(payload);
          const type = (JSON.parse(payload) as { type?: string }).type;
          if (type === "session.update" || type === "session.start") {
            queueMicrotask(() =>
              emitSideband(socket!, {
                type: "session.started",
                session: { expires_at: Math.floor(Date.now() / 1000) + 60 },
              }),
            );
          }
        };
        return socket;
      }),
    },
    openAIRealtimeHost,
  );
  return {
    bridge,
    createPeer,
    fetchImpl,
    getSocket: () => {
      if (!socket) {
        throw new Error("expected sideband socket");
      }
      return socket;
    },
  };
}

function emitDelegation(socket: FakeSocket, id: string, text: string): void {
  emitSideband(socket, {
    type: "delegation.created",
    item: {
      type: "delegation",
      target: "client",
      id,
      content: [{ type: "input_text", text }],
    },
  });
}

describe("OpenAI Quicksilver gateway bridge lifecycle", () => {
  it("keeps public transcript batch finals separate from response completion", async () => {
    const onTranscript = vi.fn();
    const onResponseDone = vi.fn();
    const harness = createBridge({
      model: "gpt-live-1",
      runAgentConsult: vi.fn(async () => ({ text: "Done" })),
      onTranscript,
      onResponseDone,
    });
    try {
      await harness.bridge.connect();
      const socket = harness.getSocket();
      for (const delta of ["a".repeat(8_000), "b"]) {
        emitSideband(socket, {
          type: "session.output_transcript.delta",
          delta,
          start_ms: 0,
          end_ms: 100,
        });
      }
      expect(onTranscript).toHaveBeenCalledWith("assistant", "a".repeat(8_000), true);
      expect(onResponseDone).not.toHaveBeenCalled();
      emitSideband(socket, { type: "session.closed", reason: "close_requested" });
      expect(onTranscript).toHaveBeenCalledWith("assistant", "b", true);
      expect(onResponseDone).not.toHaveBeenCalled();
    } finally {
      await harness.bridge.close();
    }
  });

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
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "assistant", transcript: "Recovered" },
      });

      expect(onError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message: "OpenAI GPT-Live provider error",
        }),
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
    emitDelegation(socket, "delegation-abort", "Cancel this on close");
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
      let resolveConsult!: (result: { text: string }) => void;
      const consultResult = new Promise<{ text: string }>((resolve) => {
        resolveConsult = resolve;
      });
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
        emitDelegation(socket, "delegation-detach", "Finish after disconnect");
        await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
        expect(
          parseSent(socket).filter((event) => event.type === "session.context.append"),
        ).toHaveLength(classified ? 1 : 0);

        await harness.bridge.close({ disposition: "detach" });
        const sentAtClose = socket.sent.length;
        emitDelegation(socket, "late", "Do not acknowledge after detach");
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
