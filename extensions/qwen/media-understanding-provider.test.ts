import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import qwenPlugin from "./index.js";

installPinnedHostnameTestHooks();

const videoRequest = {
  buffer: Buffer.from("video-bytes"),
  fileName: "clip.mp4",
  mime: "video/mp4",
  apiKey: "test-key",
  timeoutMs: 1500,
  baseUrl: "https://example.com/v1",
};
// Initialize the host metadata readers through plugin registration before timed requests.
const { mediaUnderstandingProviders } = capturePluginRegistration(qwenPlugin);
const qwenProvider = requireRegisteredProvider(mediaUnderstandingProviders, "qwen");
const describeQwenVideo = qwenProvider.describeVideo;
if (!describeQwenVideo) {
  throw new Error("expected Qwen video description capability");
}

describe("qwen media understanding provider", () => {
  it("uses a currently served multimodal default", () => {
    expect(qwenProvider.defaultModels).toEqual({
      image: "qwen3.6-plus",
      video: "qwen3.6-plus",
    });
  });
});

describe("describeQwenVideo", () => {
  it("builds the expected OpenAI-compatible video payload", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [
        {
          message: {
            content: [{ text: " first " }, { text: "second" }],
          },
        },
      ],
    });

    const result = await describeQwenVideo({
      ...videoRequest,
      model: "qwen-vl-max",
      prompt: "summarize the clip",
      headers: { "X-Other": "1" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result.model).toBe("qwen-vl-max");
    expect(result.text).toBe("first\nsecond");
    expect(url).toBe("https://example.com/v1/chat/completions");
    if (!init) {
      throw new Error("expected Qwen request init");
    }
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-other")).toBe("1");

    if (typeof init.body !== "string" && !Buffer.isBuffer(init.body)) {
      throw new Error("expected a JSON request body");
    }
    const body = JSON.parse(init.body.toString());
    expect(body.model).toBe("qwen-vl-max");
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "summarize the clip" },
          {
            type: "video_url",
            video_url: { url: `data:video/mp4;base64,${videoRequest.buffer.toString("base64")}` },
          },
        ],
      },
    ]);
  });

  it("bounds successful Qwen video JSON bodies instead of buffering the whole response", async () => {
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });

    await expect(
      describeQwenVideo({
        ...videoRequest,
        fetchFn: async () => streamed.response,
      }),
    ).rejects.toThrow("Qwen video description failed: JSON response exceeds 16777216 bytes");

    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });

  it("reports malformed Qwen video JSON with a provider-owned error", async () => {
    const response = new Response("not-json{", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

    await expect(
      describeQwenVideo({
        ...videoRequest,
        fetchFn: async () => response,
      }),
    ).rejects.toThrow("Qwen video description failed: malformed JSON response");
  });
});
