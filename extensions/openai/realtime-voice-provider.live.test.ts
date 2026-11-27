// OpenAI tests cover the native realtime voice bridge against the live API.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createRealtimeVoiceSessionHarness,
  type RealtimeVoiceResponseOutcome,
} from "openclaw/plugin-sdk/realtime-voice";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { describe, expect, it } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() ?? "";
const LIVE_ENABLED = OPENAI_API_KEY.length > 0 && process.env.OPENCLAW_LIVE_TEST === "1";
const describeLive = LIVE_ENABLED ? describe : describe.skip;
// 96x48 JPEG: left half red, right half blue.
const RED_LEFT_BLUE_RIGHT_JPEG =
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAYKADAAQAAAABAAAAMAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAMABgAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUVFRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHf/dAAQABv/aAAwDAQACEQMRAD8A8Xooor8pP7+CiiigAooooA8hooor/VQ/zXCiiigAooooA//Q8Xooor8pP7+CiiigAooooA8hooor/VQ/zXCiiigAooooA//R8Xooor8pP7+CiiigAooooA8hooor/VQ/zXCiiigAooooA//Z";

describeLive("OpenAI realtime voice lifecycle live", () => {
  it("speaks again after a rejected manual response on the same connection", async () => {
    const rejected = createDeferred<void>();
    const completed = createDeferred<void>();
    const outcomes: RealtimeVoiceResponseOutcome[] = [];
    const transcripts: string[] = [];
    const errors: string[] = [];
    let audioBytes = 0;
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: "live-response-rejection",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: (reason) => ({ reason }),
        inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioStarted: () => ({}),
        outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioDone: (reason) => ({ reason }),
      },
    });
    const session = harness.createBridge({
      provider: buildOpenAIRealtimeVoiceProvider(),
      providerConfig: { apiKey: OPENAI_API_KEY, model: "gpt-realtime-2.1", voice: "marin" },
      instructions: "Only say the exact verification phrase requested by the user.",
      autoRespondToAudio: false,
      audioSink: {
        sendAudio: (audio) => {
          audioBytes += audio.byteLength;
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (role === "assistant" && isFinal) {
          transcripts.push(text);
        }
      },
      onError: (error) => {
        errors.push(error.message);
        rejected.resolve();
      },
      onResponseDone: (outcome) => {
        outcomes.push(outcome);
        if (outcome.status === "failed") {
          session.sendUserMessage("Say exactly: Voice recovery verified.");
        } else if (outcome.status === "completed") {
          completed.resolve();
        }
      },
    });

    try {
      await session.connect();
      session.bridge.sendUserMessage?.("Run the unavailable verification tool.", {
        toolChoice: { type: "function", name: "unavailable_verification_tool" },
      });
      await withTimeout(rejected.promise, 20_000, {
        message: "Expected response.create rejection",
      });
      expect(outcomes).toMatchObject([{ status: "failed" }]);
      await withTimeout(completed.promise, 30_000, {
        message: "Expected recovered spoken response",
      });
      expect(outcomes.map((outcome) => outcome.status)).toEqual(["failed", "completed"]);
      expect(errors).toHaveLength(1);
      expect(audioBytes).toBeGreaterThan(0);
      expect(transcripts.join(" ")).toMatch(/voice recovery verified/i);
      expect(session.bridge.isConnected()).toBe(true);
    } finally {
      await session.close();
      harness.close();
    }
  }, 60_000);

  it("describes an image attached to the conversation", async () => {
    const completed = createDeferred<void>();
    const transcripts: string[] = [];
    const errors: string[] = [];
    const harness = createRealtimeVoiceSessionHarness({
      talk: {
        sessionId: "live-image-input",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "openai",
      },
      talkPayloads: {
        turnStarted: () => ({}),
        turnEnded: (reason) => ({ reason }),
        inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioStarted: () => ({}),
        outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
        outputAudioDone: (reason) => ({ reason }),
      },
    });
    const session = harness.createBridge({
      provider: buildOpenAIRealtimeVoiceProvider(),
      providerConfig: { apiKey: OPENAI_API_KEY, model: "gpt-realtime-2.1-mini", voice: "marin" },
      instructions: "Answer questions about what you are shown in a few words.",
      autoRespondToAudio: false,
      audioSink: { sendAudio: () => {} },
      onTranscript: (role, text, isFinal) => {
        if (role === "assistant" && isFinal) {
          transcripts.push(text);
        }
      },
      onError: (error) => {
        errors.push(error.message);
        completed.resolve();
      },
      onResponseDone: () => completed.resolve(),
    });

    try {
      await session.connect();
      const image = Buffer.from(RED_LEFT_BLUE_RIGHT_JPEG, "base64");
      expect(session.sendImage({ mimeType: "image/jpeg", data: image })).toBe(true);
      session.sendUserMessage(
        "Which color fills the left half of the image, and which the right half?",
      );
      await withTimeout(completed.promise, 30_000, { message: "Expected a spoken answer" });
      expect(errors).toEqual([]);
      // Left before right: a model that never saw the image has to guess both and their order.
      expect(transcripts.join(" ")).toMatch(/red[\s\S]*blue/i);
    } finally {
      await session.close();
      harness.close();
    }
  }, 60_000);

  it("reuses a bridge after a terminal close", async () => {
    let closeCount = 0;
    let readyCount = 0;
    const errors: Error[] = [];
    const bridge = buildOpenAIRealtimeVoiceProvider().createBridge({
      providerConfig: {
        apiKey: OPENAI_API_KEY,
        model: "gpt-realtime-2.1",
        voice: "marin",
      },
      instructions: "Keep this lifecycle verification session silent.",
      autoRespondToAudio: false,
      onAudio: () => {},
      onClearAudio: () => {},
      onClose: () => {
        closeCount += 1;
      },
      onError: (error) => {
        errors.push(error);
      },
      onReady: () => {
        readyCount += 1;
      },
    });

    try {
      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
      await bridge.close();

      await bridge.connect();
      expect(bridge.isConnected()).toBe(true);
    } finally {
      await bridge.close();
    }

    expect(errors).toEqual([]);
    expect(readyCount).toBe(2);
    expect(closeCount).toBe(2);
  }, 60_000);
});
