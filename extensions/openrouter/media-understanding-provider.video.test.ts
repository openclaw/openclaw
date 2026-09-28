// Openrouter tests cover video description through the media understanding provider.
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import { openrouterMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

async function describeVideo(
  params: Parameters<NonNullable<typeof openrouterMediaUnderstandingProvider.describeVideo>>[0],
) {
  const handler = openrouterMediaUnderstandingProvider.describeVideo;
  if (!handler) {
    throw new Error("expected OpenRouter video description support");
  }
  return await handler(params);
}

describe("describeOpenRouterVideo", () => {
  it("sends the video as an OpenAI-compatible video_url to OpenRouter chat completions", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "video ok" } }],
    });

    const result = await describeVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.webm",
      mime: "video/webm",
      apiKey: "sk-openrouter",
      timeoutMs: 1500,
      prompt: "List what happens on screen.",
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result).toEqual({ text: "video ok", model: "google/gemini-3.8-flash" });
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    if (!init) {
      throw new Error("expected OpenRouter request init");
    }
    expect(init.method).toBe("POST");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-openrouter");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("http-referer")).toBe("https://openclaw.ai");
    expect(headers.get("x-openrouter-title")).toBe("OpenClaw");

    if (typeof init.body !== "string") {
      throw new Error("expected OpenRouter JSON request body");
    }
    const body = JSON.parse(init.body) as {
      model?: string;
      messages?: Array<{
        content?: Array<{ type?: string; text?: string; video_url?: { url?: string } }>;
      }>;
    };
    expect(body.model).toBe("google/gemini-3.8-flash");
    expect(body.messages?.[0]?.content).toEqual([
      { type: "text", text: "List what happens on screen." },
      {
        type: "video_url",
        video_url: {
          url: `data:video/webm;base64,${Buffer.from("video-bytes").toString("base64")}`,
        },
      },
    ]);
  });

  it("honors a configured model, base URL and header override", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "described" } }],
    });

    const result = await describeVideo({
      buffer: Buffer.from("video"),
      fileName: "clip.mp4",
      apiKey: "sk-openrouter",
      timeoutMs: 1000,
      baseUrl: "https://openrouter.example/api/v1/",
      model: "qwen/qwen3.8-flash",
      headers: { "X-OpenRouter-Title": "Custom" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result).toEqual({ text: "described", model: "qwen/qwen3.8-flash" });
    expect(url).toBe("https://openrouter.example/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("x-openrouter-title")).toBe("Custom");
  });
});
