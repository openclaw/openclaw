import { assert, expect, it, vi } from "vitest";
import type { RtpPacket, RTCPeerConnection } from "werift";
import { openAIRealtimeHost } from "./realtime-host.js";
import {
  type OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverGatewayBridge } from "./realtime-quicksilver-gateway-bridge.js";
import {
  OpenAIQuicksilverAudioPeer,
  type OpenAIQuicksilverAudioPeerContract,
} from "./realtime-quicksilver-media.runtime.js";
import { createCallResponse, FakeSocket } from "./realtime-quicksilver.test-helpers.js";

const MAX_PENDING_RELAY_FRAMES = 250;
const MAX_PENDING_AUDIO_BYTES = OPENAI_QUICKSILVER_RELAY_FRAME_BYTES * MAX_PENDING_RELAY_FRAMES;
type PeerOptions = Parameters<typeof OpenAIQuicksilverAudioPeer.create>[0];

type TestableAudioPeer = {
  pendingAudio: OpenAIQuicksilverPendingAudio;
  sequenceNumber: number;
  timestamp: number;
  takeNextRelayFrame(): Buffer;
  state: {
    peer: Pick<RTCPeerConnection, "connectionStateChange">;
    transceiver: {
      sender: {
        sendRtp(packet: RtpPacket): Promise<void>;
      };
    };
  };
};

it("retains the newest five seconds through delayed peer adoption and the RTP pump", async () => {
  vi.useFakeTimers();
  const pendingPeer = Promise.withResolvers<OpenAIQuicksilverAudioPeerContract>();
  const createPeer = vi.fn((_callbacks: PeerOptions["callbacks"]) => pendingPeer.promise);
  const onError = vi.fn();
  const bridge = new OpenAIQuicksilverGatewayBridge(
    {
      providerConfig: {},
      model: "gpt-live-test-canary",
      voice: "marin",
      audioFormat: { encoding: "pcm16", sampleRateHz: 24_000, channels: 1 },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
      onError,
      runAgentConsult: vi.fn(async () => ({ text: "done" })),
      logger: { debug: vi.fn(), warn: vi.fn() },
      resolveAuth: vi.fn(async () => ({
        type: "oauth" as const,
        token: "oauth-token",
        accountId: "account-1",
      })),
      createPeer,
      fetchImpl: vi.fn(async () => createCallResponse("v=answer\r\n", "rtc_pending_audio")),
      webSocketFactory: () => new FakeSocket(),
    },
    openAIRealtimeHost,
  );
  const connection = bridge.connect();
  const source = Buffer.alloc(256 * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);
  for (let offset = 0; offset < source.length; offset += 2) {
    source.writeUInt16LE(Math.floor(offset / OPENAI_QUICKSILVER_RELAY_FRAME_BYTES) + 1, offset);
  }
  for (let offset = 0; offset < source.length; offset += 8_192) {
    const callerBuffer = Buffer.from(source.subarray(offset, offset + 8_192));
    bridge.sendAudio(callerBuffer);
    callerBuffer.fill(0xff);
    await vi.advanceTimersByTimeAsync(171);
  }
  const testBridge = bridge as unknown as Pick<TestableAudioPeer, "pendingAudio">;
  expect(testBridge.pendingAudio).toHaveLength(MAX_PENDING_AUDIO_BYTES);
  const bridgePendingAudio = testBridge.pendingAudio;
  const callbacks = createPeer.mock.calls[0]?.[0];
  assert(callbacks, "expected the bridge to start peer creation");
  const peer = await OpenAIQuicksilverAudioPeer.create({ callbacks, iceServers: [] });
  vi.spyOn(peer, "createOffer").mockResolvedValue("v=offer\r\n");
  vi.spyOn(peer, "applyAnswer").mockResolvedValue();
  const testPeer = peer as unknown as TestableAudioPeer;
  const sender = testPeer.state.transceiver.sender;
  const sendRtp = vi.spyOn(sender, "sendRtp").mockResolvedValue(undefined);
  const takeNextRelayFrame = vi.spyOn(testPeer, "takeNextRelayFrame");
  const { sequenceNumber, timestamp } = testPeer;
  const copy = vi.spyOn(Buffer.prototype, "copy");
  try {
    pendingPeer.resolve(peer);
    await connection;

    expect(copy).not.toHaveBeenCalled();
    expect(testPeer.pendingAudio).toBe(bridgePendingAudio);
    expect(testPeer.pendingAudio).toHaveLength(MAX_PENDING_AUDIO_BYTES);
    expect(testBridge.pendingAudio).not.toBe(bridgePendingAudio);
    expect(testBridge.pendingAudio).toHaveLength(0);
    copy.mockRestore();

    testPeer.state.peer.connectionStateChange.execute("connected");
    await vi.advanceTimersByTimeAsync(4_980);

    expect(testPeer.pendingAudio).toHaveLength(0);
    const emittedFrames = takeNextRelayFrame.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    );
    expect(emittedFrames.map((frame) => frame.readUInt16LE(0))).toEqual(
      Array.from({ length: MAX_PENDING_RELAY_FRAMES }, (_, index) => index + 7),
    );
    expect(sendRtp).toHaveBeenCalledTimes(MAX_PENDING_RELAY_FRAMES);
    const packets = sendRtp.mock.calls.map(([packet]) => packet);
    expect(packets.every((packet) => packet.header.payloadType === 111)).toBe(true);
    expect(packets.every((packet) => packet.payload.length > 0)).toBe(true);
    expect(packets.at(-1)?.header).toMatchObject({
      sequenceNumber: (sequenceNumber + MAX_PENDING_RELAY_FRAMES - 1) & 0xffff,
      timestamp: (timestamp + (MAX_PENDING_RELAY_FRAMES - 1) * 960) >>> 0,
    });
    expect(onError).not.toHaveBeenCalled();
  } finally {
    copy.mockRestore();
    await bridge.close();
    vi.useRealTimers();
  }
});
