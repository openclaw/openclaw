import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRealtimeAudioPeer } from "./realtime-voice-webrtc-peer.runtime.js";

type TestablePeer = {
  state: {
    peer: {
      connectionStateChange: { execute(state: "connected"): void };
    };
    transceiver: {
      sender: { sendRtp(packet: unknown): Promise<void> };
    };
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Codex realtime WebRTC Opus peer", () => {
  it("offers 48 kHz stereo Opus and packetizes 24 kHz mono relay audio", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const peer = await CodexRealtimeAudioPeer.create({
      callbacks: { onAudio: vi.fn(), onError },
      iceServers: [],
    });
    const testPeer = peer as unknown as TestablePeer;
    const sendRtp = vi
      .spyOn(testPeer.state.transceiver.sender, "sendRtp")
      .mockResolvedValue(undefined);

    try {
      const offer = await peer.createOffer();
      expect(offer).toMatch(/a=rtpmap:111 opus\/48000\/2/iu);

      peer.sendAudio(Buffer.alloc(480 * 2, 0x01));
      testPeer.state.peer.connectionStateChange.execute("connected");
      await vi.advanceTimersByTimeAsync(0);

      expect(sendRtp).toHaveBeenCalledOnce();
      expect(sendRtp.mock.calls[0]?.[0]).toMatchObject({
        header: { payloadType: 111 },
      });
      const packet = sendRtp.mock.calls[0]?.[0] as { payload: Buffer } | undefined;
      if (!packet) {
        throw new Error("expected one outbound Opus RTP packet");
      }
      expect(packet.payload.length).toBeGreaterThan(0);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("round-trips the MVP media shape through 48 kHz stereo PCM", () => {
    const input = Buffer.alloc(480 * 2);
    input.writeInt16LE(12_000, 0);
    const encodedShape = CodexRealtimeAudioPeer.convertRelayPcm(input);
    const output = CodexRealtimeAudioPeer.convertCodexRealtimePcm(encodedShape);

    expect(encodedShape).toHaveLength(960 * 2);
    expect(output).toHaveLength(input.length);
    expect(Math.abs(output.readInt16LE(0) - input.readInt16LE(0))).toBeLessThan(2_000);
  });
});
