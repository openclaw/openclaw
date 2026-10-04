import { describe, expect, it, vi } from "vitest";
import { openAIRealtimeHost } from "./realtime-host.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type QuicksilverAudioWorkerCommand,
  type QuicksilverAudioWorkerEvent,
} from "./realtime-quicksilver-peer.runtime.js";
import {
  createCallResponse,
  emitSideband,
  FakeSocket,
} from "./realtime-quicksilver.test-helpers.js";

const transport = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const events: QuicksilverAudioWorkerEvent[] = [];
  const acknowledgments: QuicksilverAudioWorkerCommand[] = [];
  const receivedRtp = new EventEmitter();
  const decoded: Array<number | "plc"> = [];
  const parent = Object.assign(new EventEmitter(), {
    postMessage(event: QuicksilverAudioWorkerEvent) {
      if (event.type === "audio") {
        events.push(event);
      } else {
        queueMicrotask(() => worker.emit("message", event));
      }
    },
    close() {},
  });
  const worker = Object.assign(new EventEmitter(), {
    postMessage(command: QuicksilverAudioWorkerCommand) {
      if (command.type === "audio-ack") {
        acknowledgments.push(command);
      } else {
        queueMicrotask(() => parent.emit("message", command));
      }
    },
    unref() {},
    async terminate() {
      worker.emit("exit", 0);
      return 0;
    },
  });
  return { parent, worker, receivedRtp, events, acknowledgments, decoded };
});

vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: transport.parent,
  workerData: {},
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  createCpuTrackedWorker: () => transport.worker,
  resolveRuntimeWorkerUrl: () => new URL("file:///audio.worker.ts"),
  resolveRuntimeWorkerArgv: () => [],
}));
vi.mock("libopus-wasm", () => ({
  Application: { Voip: 0 },
  createEncoder: async () => ({ free() {} }),
  createDecoder: async () => ({
    decode: (packet: Uint8Array) => {
      transport.decoded.push(packet[0]!);
      return new Int16Array(960 * 2).fill(12_000);
    },
    decodePacketLoss: () => {
      transport.decoded.push("plc");
      return new Int16Array(960 * 2).fill(12_000);
    },
    free() {},
  }),
}));
vi.mock("werift", () => ({
  useOPUS: () => ({}),
  dePacketizeRtpPackets: (_codec: string, packets: { payload: Buffer }[]) => ({
    data: packets[0]!.payload,
  }),
  RTCPeerConnection: class {
    localDescription = { sdp: "v=offer\r\n" };
    onTrack = { subscribe() {} };
    connectionStateChange = { subscribe() {} };
    addTransceiver() {
      return {
        receiver: {
          track: {
            kind: "audio",
            uuid: "inbound",
            onReceiveRtp: {
              subscribe: (receive: (packet: unknown) => void) =>
                transport.receivedRtp.on("rtp", receive),
            },
          },
        },
      };
    }
    async createOffer() {
      return this.localDescription;
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async close() {}
  },
}));

describe("GPT-Live continuous WebRTC output", () => {
  it("preserves an RTP packet arriving inside the reorder window after turn.done", async () => {
    vi.useFakeTimers();
    let socket!: FakeSocket;
    const audio: Buffer[] = [];
    const onResponseDone = vi.fn();
    const onTranscript = vi.fn();
    const onError = vi.fn();
    const bridge = new OpenAIQuicksilverGatewayBridge(
      {
        providerConfig: {},
        model: "gpt-live-test-canary",
        audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
        onAudio: (chunk) => audio.push(chunk),
        onClearAudio: vi.fn(),
        onResponseDone,
        onTranscript,
        onError,
        runAgentConsult: async () => ({ text: "done" }),
        logger: { debug: vi.fn(), warn: vi.fn() },
        resolveAuth: async () => ({
          type: "oauth",
          token: "test-token",
          accountId: "test-account",
        }),
        createPeer: async (peerCallbacks) => {
          const creation = OpenAIQuicksilverAudioPeer.create({
            callbacks: peerCallbacks,
            iceServers: [],
          });
          await import("./realtime-quicksilver-audio.worker.js");
          return creation;
        },
        fetchImpl: async () => createCallResponse("v=answer\r\n", "rtc_drain"),
        webSocketFactory: () => (socket = new FakeSocket()),
      },
      openAIRealtimeHost,
    );
    try {
      await bridge.connect();
      for (const sequenceNumber of [10, 12]) {
        transport.receivedRtp.emit("rtp", {
          header: { sequenceNumber, ssrc: 1 },
          payload: Buffer.from([sequenceNumber]),
        });
      }
      // Packet 12 waits for packet 11 within the existing 80-ms reorder window.
      expect(transport.events).toHaveLength(1);
      expect(audio).toHaveLength(0);
      const finish = () =>
        emitSideband(socket, {
          type: "turn.done",
          turn: { role: "assistant", transcript: "Finished reply" },
        });
      finish();
      expect(onResponseDone).not.toHaveBeenCalled();
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "Finished reply", true);
      await vi.advanceTimersByTimeAsync(40);
      transport.receivedRtp.emit("rtp", {
        header: { sequenceNumber: 11, ssrc: 1 },
        payload: Buffer.from([11]),
      });
      expect(transport.decoded).toEqual([10, 11, 12]);
      expect(onResponseDone).not.toHaveBeenCalled();

      transport.worker.emit("message", transport.events.shift());
      expect(transport.acknowledgments).toHaveLength(1);
      expect(onResponseDone).not.toHaveBeenCalled();
      transport.parent.emit("message", transport.acknowledgments.shift());
      expect(transport.events).toHaveLength(1);
      transport.worker.emit("message", transport.events.shift());
      transport.parent.emit("message", transport.acknowledgments.shift());

      // A contiguous tail can also arrive after both received queues are empty.
      transport.receivedRtp.emit("rtp", {
        header: { sequenceNumber: 13, ssrc: 1 },
        payload: Buffer.from([13]),
      });
      expect(transport.events).toHaveLength(1);
      transport.worker.emit("message", transport.events.shift());

      // The continuous resampler retains seven samples for its next RTP packet.
      expect(Buffer.concat(audio)).toHaveLength((4 * 480 - 7) * 2);
      expect(Buffer.concat(audio).readInt16LE((4 * 480 - 7) * 2 - 2)).toBe(12_000);
      expect(transport.decoded).toEqual([10, 11, 12, 13]);
      expect(onResponseDone).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(80);
      expect(transport.events).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "Finished reply", true);
      await transport.worker.terminate();
      vi.useRealTimers();
    }
  });
});
