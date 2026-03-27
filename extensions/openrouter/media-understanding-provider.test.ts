import { describe, expect, it } from "vitest";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "../../src/media-understanding/audio.test-helpers.js";
import {
  openrouterMediaUnderstandingProvider,
  transcribeOpenRouterAudio,
} from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

describe("openrouterMediaUnderstandingProvider", () => {
  it("has expected provider metadata", () => {
    expect(openrouterMediaUnderstandingProvider.id).toBe("openrouter");
    expect(openrouterMediaUnderstandingProvider.capabilities).toEqual(["audio"]);
    expect(openrouterMediaUnderstandingProvider.transcribeAudio).toBeDefined();
  });

  it("uses OpenRouter chat completions with input_audio by default", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "hello from audio" } }],
    });

    const result = await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio-bytes"),
      fileName: "voice.ogg",
      mime: "audio/ogg",
      apiKey: "test-openrouter-key", // pragma: allowlist secret
      timeoutMs: 5000,
      fetchFn,
    });

    const request = getRequest();
    expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = new Headers(request.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer test-openrouter-key");

    const body = JSON.parse(String(request.init?.body)) as {
      model: string;
      messages: Array<{
        role: string;
        content: Array<
          | { type: "text"; text: string }
          | { type: "input_audio"; input_audio: { data: string; format: string } }
        >;
      }>;
    };
    expect(body.model).toBe("google/gemini-3-flash-preview");
    expect(body.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Please transcribe this audio file.",
    });
    expect(body.messages[0]?.content[1]).toEqual({
      type: "input_audio",
      input_audio: {
        data: Buffer.from("audio-bytes").toString("base64"),
        format: "ogg",
      },
    });
    expect(result).toEqual({
      text: "hello from audio",
      model: "google/gemini-3-flash-preview",
    });
  });

  it("allows overriding baseUrl, model, prompt, and language hint", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: [{ type: "text", text: "bonjour" }] } }],
    });

    await transcribeOpenRouterAudio({
      buffer: Buffer.from("audio"),
      fileName: "note.mp3",
      mime: "audio/mpeg",
      apiKey: "key", // pragma: allowlist secret
      timeoutMs: 1000,
      baseUrl: "https://openrouter-proxy.example/v1",
      model: "google/gemini-3-flash",
      prompt: "Return only the transcript.",
      language: "fr",
      fetchFn,
    });

    const request = getRequest();
    expect(request.url).toBe("https://openrouter-proxy.example/v1/chat/completions");
    const body = JSON.parse(String(request.init?.body)) as {
      model: string;
      messages: Array<{
        content: Array<
          { type: "text"; text: string } | { type: "input_audio"; input_audio: { format: string } }
        >;
      }>;
    };
    expect(body.model).toBe("google/gemini-3-flash");
    expect(body.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "Return only the transcript.\nExpected language: fr.",
    });
    expect(body.messages[0]?.content[1]).toEqual({
      type: "input_audio",
      input_audio: {
        data: Buffer.from("audio").toString("base64"),
        format: "mp3",
      },
    });
  });
});
