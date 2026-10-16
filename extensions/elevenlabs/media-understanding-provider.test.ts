import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it, vi } from "vitest";
import { elevenLabsMediaUnderstandingProvider } from "./media-understanding-provider.js";

describe("elevenLabsMediaUnderstandingProvider", () => {
  installPinnedHostnameTestHooks();
  const request = {
    buffer: Buffer.from("audio"),
    fileName: "voice.mp3",
    mime: "audio/mpeg",
    apiKey: "eleven-key",
    timeoutMs: 1000,
  };

  it("posts multipart audio to ElevenLabs speech-to-text", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "hello" }));

    const result = await elevenLabsMediaUnderstandingProvider.transcribeAudio!({
      ...request,
      language: "en",
      fetchFn: fetchMock,
    });

    expect(result).toEqual({ text: "hello", model: "scribe_v2" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = expectDefined(fetchMock.mock.calls[0], "ElevenLabs fetch call");
    const init = expectDefined(requestInit, "ElevenLabs request init");
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("xi-api-key")).toBe("eleven-key");
    const form = init.body as FormData;
    expect(form.get("model_id")).toBe("scribe_v2");
    expect(form.get("language_code")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("rejects non-object successful speech-to-text JSON with a stable provider error", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([])));

    await expect(
      elevenLabsMediaUnderstandingProvider.transcribeAudio!({
        ...request,
        model: "scribe_v2",
        fetchFn: fetchMock,
      }),
    ).rejects.toThrow("ElevenLabs audio transcription failed: malformed JSON response");
  });
});
