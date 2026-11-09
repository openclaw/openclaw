import { performance } from "node:perf_hooks";
import { AudioFrame, AudioSource } from "@livekit/rtc-node";
import { expect, it, vi } from "vitest";
import type { RealtimeMediaTransport } from "../webhook/realtime-handler.js";
import { connectLiveKitAudio } from "./livekit-audio.js";

// Real native audio queue, synthetic room admission only: no RTC connection,
// SIP, credentials, model session or network. A short real-time test is needed
// because SDK queuedDuration uses process.hrtime, not the Vitest clock.
vi.mock("@livekit/rtc-node", async (original) => {
  const rtc = await original<typeof import("@livekit/rtc-node")>();
  const { EventEmitter } = await import("node:events");
  return {
    ...rtc,
    Room: class extends EventEmitter {
      name = "native-offline";
      remoteParticipants = new Map([
        ["sip", { identity: "sip", sid: "PA", trackPublications: new Map() }],
      ]);
      localParticipant = { publishTrack: async () => {} };
      async connect() {}
      async disconnect() {}
    },
  };
});

it("confirms native 160ms prefix while sustained captures continue, not at utterance drain", async () => {
  let transport!: RealtimeMediaTransport;
  let acknowledged!: (elapsed: number) => void;
  const ack = new Promise<number>((resolve) => {
    acknowledged = resolve;
  });
  let start = 0;
  let capturesAtAck = -1;
  let captures = 0;
  const connection = await connectLiveKitAudio({
    url: "wss://offline.invalid",
    token: "synthetic",
    room: "native-offline",
    identity: "sip",
    participantSid: "PA",
    callId: "native",
    isCurrent: () => true,
    onDisconnect: () => {},
    handler: {
      attachRoomTransport: async (params) => {
        transport = params.transport;
        return {
          sendAudio: () => {},
          endCall: async () => {},
          acknowledgeMark: () => {
            capturesAtAck = captures;
            acknowledged(performance.now() - start);
          },
        };
      },
    },
  });
  try {
    const media = JSON.stringify({
      event: "media",
      media: { payload: Buffer.alloc(160, 255).toString("base64") },
    });
    start = performance.now();
    for (let i = 0; i < 8; i++) {
      transport.send(media);
    }
    transport.send(JSON.stringify({ event: "mark", mark: { name: "prefix-160" } }));
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        transport.send(media);
        if (++captures === 30) {
          clearInterval(interval);
          resolve();
        }
      }, 20);
    });
    const ackMs = await ack;
    expect(ackMs).toBeGreaterThan(100);
    // Allow scheduling jitter, but retain the independent structural proof:
    // acknowledgement must arrive with >=200ms of future captures remaining.
    expect(ackMs).toBeLessThan(550);
    expect(capturesAtAck).toBeGreaterThanOrEqual(0);
    expect(capturesAtAck).toBeLessThanOrEqual(20);
  } finally {
    await connection.close();
  }
});

it("native AudioSource queuedDuration is milliseconds", async () => {
  const source = new AudioSource(8000, 1, 200);
  try {
    await source.captureFrame(new AudioFrame(new Int16Array(1280), 8000, 1, 1280));
    expect(source.queuedDuration).toBeGreaterThan(100);
    expect(source.queuedDuration).toBeLessThanOrEqual(160);
  } finally {
    await source.close();
  }
});
