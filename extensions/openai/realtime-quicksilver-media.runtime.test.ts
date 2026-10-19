import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenAIQuicksilverPendingAudio,
  OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
} from "./realtime-quicksilver-audio-buffer.js";
import { OpenAIQuicksilverAudioPeer } from "./realtime-quicksilver-media.runtime.js";

type LibopusModule = typeof import("libopus-wasm");
type LibopusDecoder = Awaited<ReturnType<LibopusModule["createDecoder"]>>;
type LibopusEncoder = Awaited<ReturnType<LibopusModule["createEncoder"]>>;
type WeriftPeer = InstanceType<(typeof import("werift"))["RTCPeerConnection"]>;

const libopusFactoryOverrides = vi.hoisted(() => ({
  createDecoder: undefined as LibopusModule["createDecoder"] | undefined,
  createEncoder: undefined as LibopusModule["createEncoder"] | undefined,
}));

vi.mock("libopus-wasm", async (importOriginal) => {
  const actual = await importOriginal<LibopusModule>();
  return {
    ...actual,
    createDecoder: (...args: Parameters<LibopusModule["createDecoder"]>) =>
      (libopusFactoryOverrides.createDecoder ?? actual.createDecoder)(...args),
    createEncoder: (...args: Parameters<LibopusModule["createEncoder"]>) =>
      (libopusFactoryOverrides.createEncoder ?? actual.createEncoder)(...args),
  };
});

const peers: OpenAIQuicksilverAudioPeer[] = [];
afterEach(() => {
  for (const peer of peers.splice(0)) {
    peer.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  libopusFactoryOverrides.createEncoder = undefined;
  libopusFactoryOverrides.createDecoder = undefined;
});

async function createAudioPeer(
  callbacks: Partial<Parameters<typeof OpenAIQuicksilverAudioPeer.create>[0]["callbacks"]> = {},
  signal?: AbortSignal,
) {
  const onAudio = vi.fn<(audio: Buffer) => void>();
  const onError = vi.fn();
  const peer = await OpenAIQuicksilverAudioPeer.create({
    callbacks: { onAudio, onError, ...callbacks },
    iceServers: [],
    signal,
  });
  peers.push(peer);
  return { peer, testPeer: peer as unknown as TestableAudioPeer, onAudio, onError };
}

function createRelayTone(): Buffer {
  const pcm = Buffer.alloc(480 * 2);
  for (let index = 0; index < 480; index += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((index / 24_000) * 2 * Math.PI * 440) * 12_000),
      index * 2,
    );
  }
  return pcm;
}

type TestableAudioPeer = {
  connected: boolean;
  handleInboundRtp(packet: unknown): void;
  pendingAudio: OpenAIQuicksilverPendingAudio;
  sequenceNumber: number;
  timestamp: number;
  sendNextAudioFrame(): void;
  takeNextRelayFrame(): Buffer;
  state: {
    decoder: Pick<LibopusDecoder, "decode" | "decodePacketLoss">;
    encoder: Pick<LibopusEncoder, "encode">;
    peer: WeriftPeer;
    transceiver: ReturnType<WeriftPeer["addTransceiver"]>;
  };
};

async function createInboundAudioHarness(params?: {
  onRtpPacket?: () => void;
  onMediaError?: (error: Error) => void;
  decodeFailure?: { sequence: number; error: Error };
}) {
  const { RtpHeader, RtpPacket } = await import("werift");
  const audioPeer = await createAudioPeer({
    onRtpPacket: params?.onRtpPacket,
    onMediaError: params?.onMediaError,
  });
  const { testPeer } = audioPeer;
  const decodeOrder: Array<number | "plc"> = [];
  const decode = vi.spyOn(testPeer.state.decoder, "decode").mockImplementation((packet) => {
    if (params?.decodeFailure && packet?.[0] === params.decodeFailure.sequence) {
      throw params.decodeFailure.error;
    }
    decodeOrder.push(packet?.[0] ?? -1);
    return new Int16Array(960 * 2);
  });
  const decodePacketLoss = vi
    .spyOn(testPeer.state.decoder, "decodePacketLoss")
    .mockImplementation(() => {
      decodeOrder.push("plc");
      return new Int16Array(960 * 2);
    });
  const packet = (sequenceNumber: number, ssrc = 1) =>
    new RtpPacket(
      new RtpHeader({
        payloadType: 111,
        sequenceNumber,
        ssrc,
        timestamp: (sequenceNumber * 960) >>> 0,
      }),
      Buffer.from([sequenceNumber & 0xff]),
    );
  const receive = (...sequences: number[]) => {
    for (const sequence of sequences) {
      testPeer.handleInboundRtp(packet(sequence));
    }
  };
  return { ...audioPeer, decode, decodeOrder, decodePacketLoss, packet, receive };
}

async function captureOutboundRtp(testPeer: TestableAudioPeer) {
  const { RtpPacket } = await import("werift");
  const packets: Array<{ atMs: number; sequenceNumber: number; timestamp: number }> = [];
  vi.spyOn(testPeer.state.transceiver.sender, "sendRtp").mockImplementation(async (packet) => {
    const rtp = Buffer.isBuffer(packet) ? RtpPacket.deSerialize(packet) : packet;
    if (!(rtp instanceof RtpPacket)) {
      throw new Error("Expected an RTP packet");
    }
    packets.push({
      atMs: performance.now(),
      sequenceNumber: rtp.header.sequenceNumber,
      timestamp: rtp.header.timestamp,
    });
  });
  return packets;
}

describe("GPT-Live werift audio peer", () => {
  it("creates a full-candidate Opus sendrecv offer without a data channel", async () => {
    const { peer } = await createAudioPeer();
    const offer = await peer.createOffer();
    expect(offer).toMatch(/^m=audio .*UDP\/TLS\/RTP\/SAVPF 111$/m);
    expect(offer).toMatch(/^a=rtpmap:111 OPUS\/48000\/2$/im);
    expect(offer).toMatch(/^a=sendrecv$/m);
    expect(offer).toMatch(/^a=candidate:/m);
    expect(offer).toMatch(/^a=end-of-candidates$/m);
    expect(offer).not.toMatch(/^m=application /m);
  });

  it.each([
    ["second SSRC", 10, 200, 2, "audio source"],
    ["sequence discontinuity", 40_000, 10_000, 1, "RTP sequence"],
  ] as const)(
    "rejects %s before it can share Opus decoder state",
    async (_name, first, next, ssrc, message) => {
      const { decodeOrder, decodePacketLoss, onError, packet, testPeer } =
        await createInboundAudioHarness();
      testPeer.handleInboundRtp(packet(first, 1));
      testPeer.handleInboundRtp(packet(next, ssrc));

      expect(decodeOrder).toEqual([first & 0xff]);
      expect(decodePacketLoss).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({ message: `GPT-Live WebRTC ${message} changed unexpectedly` }),
      );
    },
  );

  it("keeps raw Opus RTP payload framing and round-trips relay PCM", async () => {
    const { RtpPacket, dePacketizeRtpPackets } = await import("werift");
    const { peer, testPeer, onAudio, onError } = await createAudioPeer();
    const send = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockImplementation(async (packet) => {
        if (!(packet instanceof RtpPacket)) {
          throw new Error("Expected an RTP packet");
        }
        expect(dePacketizeRtpPackets("opus", [packet]).data).toEqual(packet.payload);
        testPeer.handleInboundRtp(packet);
      });
    testPeer.connected = true;
    for (let index = 0; index < 3; index += 1) {
      peer.sendAudio(createRelayTone());
      testPeer.sendNextAudioFrame();
    }
    await Promise.resolve();
    const relayPcm = Buffer.concat(onAudio.mock.calls.map(([audio]) => audio));
    expect(send).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
    // The streaming filter retains seven samples until the next packet.
    expect(relayPcm).toHaveLength((3 * 480 - 7) * 2);
    expect(
      Math.max(
        ...Array.from({ length: relayPcm.length / 2 }, (_, i) =>
          Math.abs(relayPcm.readInt16LE(i * 2)),
        ),
      ),
    ).toBeGreaterThan(1_000);
  });

  it("retires buffered RTP across rollover and delayed PCM at clear", async () => {
    const expected = [254, "plc", 0, "plc", 2];
    const { decode, decodeOrder, onAudio, onError, receive, peer } =
      await createInboundAudioHarness();
    let cleared = false;
    decode.mockImplementation((opus) => {
      decodeOrder.push(opus?.[0] ?? -1);
      return new Int16Array(960 * 2).fill(cleared ? 0 : 12_000);
    });
    vi.useFakeTimers();
    receive(65_534, 0, 2);
    expect(decodeOrder).toEqual([254]);
    expect(onAudio).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    peer.clearOutputAudio();
    // Advance Opus/sequence state while discarding output, rather than
    // forgetting the stream and admitting a late pre-clear packet as fresh.
    expect(decodeOrder).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(80);
    receive(65_535, 0, 1, 2);
    expect(decodeOrder).toEqual(expected);
    expect(onAudio).toHaveBeenCalledOnce();

    cleared = true;
    receive(3);
    expect(decodeOrder).toEqual([...expected, 3]);
    expect(onAudio).toHaveBeenCalledTimes(2);
    // A fresh silent packet must not release the filter's old audible tail.
    expect(onAudio.mock.calls[1]?.[0]).toEqual(Buffer.alloc((480 - 7) * 2));

    receive(5);
    await vi.advanceTimersByTimeAsync(79);
    expect(decodeOrder).toEqual([...expected, 3]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decodeOrder).toEqual([...expected, 3, "plc", 5]);
    expect(onAudio).toHaveBeenCalledTimes(4);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([
    { packets: [20, 22, 23, 24, 25], expected: [20, "plc", 22, 23, 24, 25] },
    { packets: [40, 42, 43, 41], malformed: 41, expected: [40, "plc", 42, 43] },
    { packets: [40, 42, 44], malformed: 42, expected: [40, "plc", "plc", "plc", 44] },
  ])("conceals missing or malformed audio in $packets", async (scenario) => {
    const { OpusError, OpusErrorCode } = await import("libopus-wasm");
    const error = new OpusError(OpusErrorCode.InvalidPacket, "invalid packet", "decode");
    const onMediaError = vi.fn();
    const { decodeOrder, decodePacketLoss, onAudio, onError, receive } =
      await createInboundAudioHarness({
        onMediaError,
        decodeFailure:
          scenario.malformed === undefined
            ? undefined
            : {
                sequence: scenario.malformed,
                error,
              },
      });
    vi.useFakeTimers();
    receive(...scenario.packets);
    if (scenario.malformed !== undefined) {
      await vi.advanceTimersByTimeAsync(160);
    }
    expect(decodeOrder).toEqual(scenario.expected);
    expect(decodePacketLoss).toHaveBeenCalledWith(960);
    expect(Buffer.concat(onAudio.mock.calls.map(([audio]) => audio))).toHaveLength(
      (scenario.expected.length * 480 - 7) * 2,
    );
    expect(onMediaError.mock.calls).toEqual(scenario.malformed === undefined ? [] : [[error]]);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(160);
    expect(onAudio).toHaveBeenCalledTimes(scenario.expected.length);
  });

  it.each([
    ["unusable decoder state", "InvalidState", true],
    ["invalid packet without media recovery", "InvalidPacket", false],
  ] as const)("keeps %s fatal", async (_label, code, recovery) => {
    const { OpusError, OpusErrorCode } = await import("libopus-wasm");
    const error = new OpusError(OpusErrorCode[code], "decode failed", "decode");
    const onMediaError = vi.fn();
    const { onAudio, onError, receive } = await createInboundAudioHarness({
      ...(recovery ? { onMediaError } : {}),
      decodeFailure: { sequence: 41, error },
    });
    receive(40, 41);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(onMediaError).not.toHaveBeenCalled();
    expect(onAudio).toHaveBeenCalledOnce();
  });

  it("reports RTP activity callback failures through the peer error boundary", async () => {
    const activityError = new Error("activity callback failed");
    const onRtpPacket = vi.fn(() => {
      throw activityError;
    });
    const { decode, onError, receive } = await createInboundAudioHarness({
      onRtpPacket,
    });
    receive(50);

    expect(onRtpPacket).toHaveBeenCalledOnce();
    expect(decode).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(activityError);
  });

  it("consumes every audio tick while earlier RTP sends remain pending", async () => {
    const { peer, testPeer } = await createAudioPeer();
    const sendRtp = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockImplementation(async () => await new Promise<void>(() => {}));
    const frames = [1, 2, 3].map((value) => Buffer.alloc(480 * 2, value));
    const initialTimestamp = testPeer.timestamp;
    const initialSequenceNumber = testPeer.sequenceNumber;
    peer.sendAudio(Buffer.concat(frames));
    testPeer.connected = true;

    for (let index = 0; index < frames.length; index += 1) {
      testPeer.sendNextAudioFrame();
      expect(testPeer.pendingAudio).toHaveLength(
        (frames.length - index - 1) * OPENAI_QUICKSILVER_RELAY_FRAME_BYTES,
      );
    }

    expect(sendRtp).toHaveBeenCalledTimes(3);
    const packets = sendRtp.mock.calls.map(
      ([packet]) => packet as { header: { sequenceNumber: number; timestamp: number } },
    );
    expect(packets.map((packet) => packet.header)).toMatchObject(
      [0, 1, 2].map((index) => ({
        timestamp: (initialTimestamp + index * 960) >>> 0,
        sequenceNumber: (initialSequenceNumber + index) & 0xffff,
      })),
    );
  });

  it("keeps the RTP sample clock aligned through a minute of late timer callbacks", async () => {
    const { onError, peer, testPeer } = await createInboundAudioHarness();
    const packets = await captureOutboundRtp(testPeer);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    const scheduleTimeout = globalThis.setTimeout;
    const scheduleInterval = globalThis.setInterval;
    // Both timer APIs incur the same scheduler lateness; only a deadline can compensate.
    vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) =>
      scheduleTimeout(callback, (delay ?? 0) + 1, ...args),
    );
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) =>
      scheduleInterval(callback, (delay ?? 0) + 1, ...args),
    );
    peer.sendAudio(createRelayTone());
    testPeer.state.peer.connectionStateChange.execute("connected");
    expect(packets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);

    const first = packets[0]!;
    expect(packets.at(-1)!.atMs - first.atMs).toBeGreaterThanOrEqual(59_980);
    const clockErrors = packets.map((packet) =>
      Math.abs(packet.atMs - first.atMs - ((packet.timestamp - first.timestamp) >>> 0) / 48),
    );
    expect(Math.max(...clockErrors)).toBeLessThanOrEqual(20);
    expect(onError).not.toHaveBeenCalled();

    const sentBeforeClose = packets.length;
    peer.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(packets).toHaveLength(sentBeforeClose);
  });

  it("keeps queued audio paced after a five-second scheduler pause", async () => {
    const { onError, peer, testPeer } = await createInboundAudioHarness();
    const packets = await captureOutboundRtp(testPeer);
    const pendingAudio = new OpenAIQuicksilverPendingAudio();
    const readFrame = vi.spyOn(pendingAudio, "readInto");
    const frames = [1, 2, 3].map((value) =>
      Buffer.alloc(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES, value),
    );
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"],
    });
    const timerNow = performance.now.bind(performance);
    let suspensionMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => timerNow() + suspensionMs);
    peer.adoptPendingAudio(pendingAudio);
    peer.sendAudio(Buffer.concat(frames));
    testPeer.state.peer.connectionStateChange.execute("connected");
    expect(packets).toHaveLength(1);

    suspensionMs = 5_000;
    await vi.advanceTimersByTimeAsync(20);
    expect(packets).toHaveLength(2);
    expect(pendingAudio).toHaveLength(OPENAI_QUICKSILVER_RELAY_FRAME_BYTES);

    await vi.advanceTimersByTimeAsync(20);
    expect(packets).toHaveLength(3);
    const first = packets[0]!;
    expect(
      packets.map((packet) => [
        packet.atMs - first.atMs,
        (packet.timestamp - first.timestamp) >>> 0,
        (packet.sequenceNumber - first.sequenceNumber) & 0xffff,
      ]),
    ).toEqual([0, 5_020, 5_040].map((elapsed, sequence) => [elapsed, elapsed * 48, sequence]));
    expect(readFrame.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(pendingAudio).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();

    peer.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(packets).toHaveLength(3);
  });

  it("recovers one send rejection and escalates consecutive failures", async () => {
    const onMediaError = vi.fn();
    const { onError, testPeer } = await createInboundAudioHarness({ onMediaError });
    const first = new Error("first packet rejected");
    const second = new Error("second packet rejected");
    const terminal = new Error("transport remains unusable");
    const send = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockRejectedValueOnce(first)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(second)
      .mockRejectedValueOnce(terminal);
    testPeer.connected = true;
    testPeer.sendNextAudioFrame();
    await Promise.resolve();
    expect(onMediaError).toHaveBeenCalledExactlyOnceWith(first);
    testPeer.sendNextAudioFrame();
    await Promise.resolve();
    testPeer.sendNextAudioFrame();
    await Promise.resolve();
    expect(onError).not.toHaveBeenCalled();
    expect(onMediaError).toHaveBeenLastCalledWith(second);
    testPeer.sendNextAudioFrame();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(terminal);
    expect(onMediaError).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("rejects adoption over existing peer audio and clears adoption after close", async () => {
    const { peer, testPeer } = await createAudioPeer();
    const existing = Buffer.from([0x01, 0x02]);
    const rejected = new OpenAIQuicksilverPendingAudio();
    rejected.append(Buffer.from([0x03, 0x04]));
    peer.sendAudio(existing);
    expect(() => peer.adoptPendingAudio(rejected)).toThrow(
      "GPT-Live WebRTC peer already owns pending audio",
    );
    expect(rejected).toHaveLength(0);
    expect(testPeer.takeNextRelayFrame().subarray(0, existing.length)).toEqual(existing);

    peer.close();
    const afterClose = new OpenAIQuicksilverPendingAudio();
    afterClose.append(Buffer.from([0x05, 0x06]));
    peer.adoptPendingAudio(afterClose);
    expect(afterClose).toHaveLength(0);
    peer.sendAudio(existing);
    expect(testPeer.pendingAudio).toHaveLength(0);
  });

  it("consumes and zero-pads a sub-frame audio tail on the next tick", async () => {
    const { peer, testPeer } = await createAudioPeer();
    const tail = Buffer.alloc(200);
    tail.writeInt16LE(1_234, 0);
    tail.writeInt16LE(-2_345, 2);
    const takeNextRelayFrame = testPeer.takeNextRelayFrame.bind(testPeer);
    let producedFrame: Buffer | undefined;
    vi.spyOn(testPeer, "takeNextRelayFrame").mockImplementation(() => {
      producedFrame = takeNextRelayFrame();
      return producedFrame;
    });
    peer.sendAudio(tail);
    testPeer.connected = true;
    testPeer.sendNextAudioFrame();

    expect(testPeer.pendingAudio).toHaveLength(0);
    expect(producedFrame?.subarray(0, tail.length)).toEqual(tail);
    expect(producedFrame?.subarray(tail.length).every((byte) => byte === 0)).toBe(true);
  });

  it("clears the media pump when the first encoder tick synchronously closes the peer", async () => {
    const encodeError = new Error("encoder failed");
    const peerRef: { current?: OpenAIQuicksilverAudioPeer } = {};
    const onError = vi.fn((_error: Error) => peerRef.current?.close());
    const { peer, testPeer } = await createAudioPeer({ onError });
    peerRef.current = peer;
    const encode = vi.spyOn(testPeer.state.encoder, "encode").mockImplementation(() => {
      throw encodeError;
    });
    vi.useFakeTimers();
    testPeer.state.peer.connectionStateChange.execute("connected");

    expect(encode).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledExactlyOnceWith(encodeError);
    await vi.advanceTimersByTimeAsync(100);

    expect(encode).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it.each([
    ["disconnected", false],
    ["closed", false],
    ["closed", true],
  ] as const)("handles terminal %s state (locally closed: %s)", async (state, locallyClosed) => {
    const { peer, testPeer, onError } = await createAudioPeer();
    if (locallyClosed) {
      peer.close();
    }
    testPeer.state.peer.connectionStateChange.execute(state);
    expect(onError.mock.calls).toEqual(
      locallyClosed
        ? []
        : [[expect.objectContaining({ message: `GPT-Live WebRTC media connection ${state}` })]],
    );
  });

  it("constructs and offers under Bun without network access", ({ skip }) => {
    const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
    if (version.error) {
      skip("Bun is not installed");
      return;
    }
    const result = spawnSync(
      "bun",
      [
        "--eval",
        `const { RTCPeerConnection, useOPUS } = await import("werift");
const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: 111 })], video: [] }, iceServers: [] });
try {
  peer.addTransceiver("audio", { direction: "sendrecv" });
  const offer = await peer.createOffer();
  const sdp = offer.sdp ?? "";
  if (!sdp.includes("a=sendrecv") || !sdp.includes("OPUS/48000/2")) throw new Error("invalid offer");
  if (peer.iceGatheringState !== "new") throw new Error("offer construction started ICE gathering");
} finally {
  await peer.close();
}`,
      ],
      { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8", timeout: 30_000 },
    );
    expect(result).toMatchObject({ stderr: "", status: 0 });
  });

  it.each(["decoder init failed", "peer startup stopped"])(
    "releases partial codec resources: %s",
    async (message) => {
      const encoder = { free: vi.fn() };
      const decoder = { free: vi.fn() };
      const pending = Promise.withResolvers<typeof decoder>();
      const createDecoder = vi.fn(() => pending.promise);
      libopusFactoryOverrides.createEncoder = async () => encoder as unknown as LibopusEncoder;
      libopusFactoryOverrides.createDecoder = async () =>
        (await createDecoder()) as unknown as LibopusDecoder;
      const { RTCPeerConnection } = await import("werift");
      const closePeer = vi.spyOn(RTCPeerConnection.prototype, "close");
      const controller = new AbortController();
      const creation = createAudioPeer(undefined, controller.signal);
      const rejected = expect(creation).rejects.toThrow(message);
      await vi.waitFor(() => expect(createDecoder).toHaveBeenCalledOnce());
      if (message === "peer startup stopped") {
        controller.abort(new Error(message));
        await vi.waitFor(() => expect(closePeer).toHaveBeenCalled());
        expect(encoder.free).toHaveBeenCalledOnce();
        pending.resolve(decoder);
      } else {
        pending.reject(new Error(message));
      }
      await rejected;
      expect(decoder.free).toHaveBeenCalledTimes(message === "peer startup stopped" ? 1 : 0);
      expect(encoder.free).toHaveBeenCalledOnce();
      expect(closePeer).toHaveBeenCalled();
    },
  );
});
