import { InteractionStatus, type LiveServerContent, type LiveServerMessage } from "@google/genai";
import { convertPcmToMulaw8k } from "openclaw/plugin-sdk/realtime-voice-provider";
import { assert, expect, it, vi } from "vitest";
import { buildGoogleRealtimeVoiceProvider } from "./realtime-voice-provider.js";

type Callbacks = {
  onopen(): void;
  onmessage(message: Pick<LiveServerMessage, "serverContent" | "setupComplete">): void;
};

const { connect } = vi.hoisted(() => ({
  connect: vi.fn(async ({ callbacks }: { callbacks: Callbacks }) => {
    callbacks.onopen();
    callbacks.onmessage({ setupComplete: {} });
    return { close() {} };
  }),
}));

vi.mock("./google-genai-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./google-genai-runtime.js")>()),
  createGoogleGenAI: () => ({ live: { connect } }),
}));

async function openPlayback(model?: string) {
  const events: string[] = [];
  const audio: Buffer[] = [];
  const bridge = buildGoogleRealtimeVoiceProvider().createBridge({
    providerConfig: { apiKey: "test-key", model },
    onAudio: (chunk) => {
      audio.push(chunk);
      events.push("audio");
    },
    onMark: () => events.push("mark"),
    onClearAudio: () => events.push("clear"),
    onResponseDone: ({ status }) => events.push(status),
  });
  await bridge.connect();
  const callbacks = connect.mock.lastCall?.[0].callbacks;
  assert.isDefined(callbacks);
  return {
    audio,
    events,
    send: (serverContent: LiveServerContent) => callbacks.onmessage({ serverContent }),
    close: () => bridge.close(),
  };
}

function part(pcm: Buffer, rate = 24_000) {
  return { inlineData: { mimeType: `audio/pcm;rate=${rate}`, data: pcm.toString("base64") } };
}

it.each([false, true])(
  "preserves playback across split PCM parts (same message: %s)",
  async (together) => {
    const output = await openPlayback();
    const signal = Buffer.alloc(1024 * 2);
    for (let i = 0; i < signal.length / 2; i++) {
      signal.writeInt16LE(((i * 2389) % 58_001) - 29_000, i * 2);
    }
    const parts = [part(signal.subarray(0, 1024)), part(signal.subarray(1024))];
    if (together) {
      output.send({ modelTurn: { parts } });
    } else {
      for (const samplePart of parts) {
        output.send({ modelTurn: { parts: [samplePart] } });
      }
    }
    expect(output.audio.length).toBeGreaterThan(0);
    output.send({ turnComplete: true });
    expect(Buffer.concat(output.audio)).toEqual(convertPcmToMulaw8k(signal, 24_000));
    expect(output.events).toEqual([...output.audio.flatMap(() => ["audio", "mark"]), "completed"]);
    await output.close();
  },
);

it("discards interrupted playback and drains the next generation before extended turn completion", async () => {
  const output = await openPlayback("gemini-3.8-live-extended-thinking");
  output.send({ modelTurn: { parts: [part(Buffer.alloc(4))] } });
  output.send({ interrupted: true, turnComplete: true });
  expect(output.events).toEqual(["clear", "cancelled"]);

  const signal = Buffer.from([0, 64, 0, 64, 0, 64]);
  output.send({ modelTurn: { parts: [part(signal.subarray(0, 2))] } });
  output.send({ modelTurn: { parts: [part(signal.subarray(2))] }, generationComplete: true });
  expect(Buffer.concat(output.audio)).toEqual(convertPcmToMulaw8k(signal, 24_000));
  expect(output.events).toEqual(["clear", "cancelled", "audio", "mark"]);
  output.send({ turnComplete: true, interactionStatus: InteractionStatus.IN_PROGRESS });
  output.send({ turnComplete: true, interactionStatus: InteractionStatus.IDLE });
  expect(output.events).toEqual(["clear", "cancelled", "audio", "mark", "completed"]);
  await output.close();
});

it("drains the previous rate before playing native 8 kHz audio", async () => {
  const output = await openPlayback();
  const first = Buffer.from([0, 64, 0, 64, 0, 64]);
  const second = Buffer.from([0, 32, 0, 32]);
  output.send({ modelTurn: { parts: [part(first), part(second, 8_000)] } });
  expect(Buffer.concat(output.audio)).toEqual(
    Buffer.concat([convertPcmToMulaw8k(first, 24_000), convertPcmToMulaw8k(second, 8_000)]),
  );
  output.send({ turnComplete: true });
  expect(output.events).toEqual(["audio", "mark", "audio", "mark", "completed"]);
  await output.close();
});
