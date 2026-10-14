import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import { moonshotMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

type VideoRequest = Parameters<
  NonNullable<typeof moonshotMediaUnderstandingProvider.describeVideo>
>[0];

async function describeVideo(params: Partial<VideoRequest>) {
  const handler = moonshotMediaUnderstandingProvider.describeVideo;
  if (!handler) {
    throw new Error("expected Moonshot video description support");
  }
  return await handler({
    buffer: Buffer.from("video-bytes"),
    fileName: "clip.mp4",
    apiKey: "moonshot-test",
    timeoutMs: 1500,
    ...params,
  });
}

describe("describeMoonshotVideo", () => {
  it("builds an OpenAI-compatible video request", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "video ok" } }],
    });
    const result = await describeVideo({
      baseUrl: "https://api.moonshot.ai/v1/",
      model: "kimi-k2.6",
      headers: { "X-Trace": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();
    expect(result).toEqual({ text: "video ok", model: "kimi-k2.6" });
    expect(url).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer moonshot-test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("1");
    if (typeof init?.body !== "string") {
      throw new Error("expected Moonshot JSON request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      model: "kimi-k2.6",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe the video." },
            { type: "video_url", video_url: { url: "data:video/mp4;base64,dmlkZW8tYnl0ZXM=" } },
          ],
        },
      ],
    });
  });

  it("falls back to reasoning_content when content is empty", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "", reasoning_content: "reasoned answer" } }],
    });
    expect(await describeVideo({ fetchFn, timeoutMs: 1000 })).toEqual({
      text: "reasoned answer",
      model: "kimi-k2.6",
    });
  });

  it("bounds successful Moonshot video JSON bodies instead of buffering the whole response", async () => {
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });
    await expect(
      describeVideo({
        mime: "video/mp4",
        baseUrl: "https://example.com/v1",
        fetchFn: async () => streamed.response,
      }),
    ).rejects.toThrow("Moonshot video description failed: JSON response exceeds 16777216 bytes");
    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });
});
