import { describe, expect, it } from "vitest";
import { OpenAIRealtimeSTTProvider } from "./stt-openai-realtime.js";

describe("OpenAIRealtimeSTTSession waitForTranscript", () => {
  it("queues concurrent waiters and resolves in order", async () => {
    const provider = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" });
    const session = provider.createSession() as unknown as {
      waitForTranscript: (timeoutMs?: number) => Promise<string>;
      onTranscript: (callback: (transcript: string) => void) => void;
      handleEvent: (event: { type: string; transcript?: string }) => void;
    };

    const seen: string[] = [];
    session.onTranscript((transcript) => seen.push(transcript));

    const first = session.waitForTranscript(100);
    const second = session.waitForTranscript(100);

    session.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "first",
    });
    session.handleEvent({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "second",
    });

    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(seen).toEqual(["first", "second"]);
  });

  it("rejects pending waiters on close", async () => {
    const provider = new OpenAIRealtimeSTTProvider({ apiKey: "test-key" });
    const session = provider.createSession() as unknown as {
      waitForTranscript: (timeoutMs?: number) => Promise<string>;
      close: () => void;
    };

    const pending = session.waitForTranscript(1000);
    session.close();

    await expect(pending).rejects.toThrow("Transcript session closed");
  });
});
