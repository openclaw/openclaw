import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { describe, expect, it } from "vitest";
import { zaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

const describeZaiVideo = zaiMediaUnderstandingProvider.describeVideo;
if (!describeZaiVideo) {
  throw new Error("expected Z.AI video description capability");
}

describe("zai media understanding provider", () => {
  it("advertises the manifest-owned video model without changing the image default", () => {
    expect(zaiMediaUnderstandingProvider.capabilities).toEqual(["image", "video"]);
    expect(zaiMediaUnderstandingProvider.defaultModels).toEqual({
      image: "glm-4.6v",
      video: "glm-5v-turbo",
    });
    expect(zaiMediaUnderstandingProvider.autoPriority).toEqual({ image: 60, video: 30 });
  });

  it("builds an OpenAI-compatible video request for the configured endpoint", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: [{ text: " first " }, { text: "second" }] } }],
    });

    const result = await describeZaiVideo({
      buffer: Buffer.from("video-bytes"),
      fileName: "clip.webm",
      mime: "video/webm",
      apiKey: "zai-test-key",
      timeoutMs: 1500,
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
      model: "glm-4.6v-flash",
      prompt: "Summarize the clip.",
      headers: { "X-Trace": "zai-video" },
      fetchFn,
    });
    const { url, init } = getRequest();

    expect(result).toEqual({ model: "glm-4.6v-flash", text: "first\nsecond" });
    expect(url).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer zai-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trace")).toBe("zai-video");

    if (typeof init?.body !== "string") {
      throw new Error("expected Z.AI JSON request body");
    }
    expect(JSON.parse(init.body)).toEqual({
      model: "glm-4.6v-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize the clip." },
            {
              type: "video_url",
              video_url: {
                url: `data:video/webm;base64,${Buffer.from("video-bytes").toString("base64")}`,
              },
            },
          ],
        },
      ],
    });
  });

  it("uses the catalog video default and accepts reasoning-only responses", async () => {
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
      choices: [{ message: { content: "", reasoning_content: " video description " } }],
    });

    await expect(
      describeZaiVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "zai-test-key",
        timeoutMs: 1500,
        fetchFn,
      }),
    ).resolves.toEqual({ model: "glm-5v-turbo", text: "video description" });

    const { url, init } = getRequest();
    expect(url).toBe("https://api.z.ai/api/paas/v4/chat/completions");
    if (typeof init?.body !== "string") {
      throw new Error("expected Z.AI JSON request body");
    }
    const body = JSON.parse(init.body) as {
      messages: Array<{ content: Array<{ text?: string; video_url?: { url: string } }> }>;
    };
    expect(body.messages[0]?.content[0]?.text).toBe("Describe the video.");
    expect(body.messages[0]?.content[1]?.video_url?.url).toMatch(/^data:video\/mp4;base64,/);
  });

  it("reports non-success responses with a provider-owned error", async () => {
    await expect(
      describeZaiVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "zai-test-key",
        timeoutMs: 1500,
        fetchFn: async () =>
          new Response(JSON.stringify({ error: { message: "invalid video" } }), {
            status: 422,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("Z.AI video description failed (HTTP 422): invalid video");
  });

  it("rejects successful responses without video-description content", async () => {
    const { fetchFn } = createRequestCaptureJsonFetch({ choices: [{ message: { content: " " } }] });

    await expect(
      describeZaiVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "zai-test-key",
        timeoutMs: 1500,
        fetchFn,
      }),
    ).rejects.toThrow("Z.AI video description response missing content");
  });

  it("reports malformed JSON with a provider-owned error", async () => {
    await expect(
      describeZaiVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "zai-test-key",
        timeoutMs: 1500,
        fetchFn: async () =>
          new Response("not-json{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      }),
    ).rejects.toThrow("Z.AI video description failed: malformed JSON response");
  });

  it("bounds successful video JSON bodies instead of buffering an unbounded response", async () => {
    const streamed = oversizedJsonResponse({ chunkCount: 64, chunkSize: 1024 * 1024 });

    await expect(
      describeZaiVideo({
        buffer: Buffer.from("video"),
        fileName: "clip.mp4",
        apiKey: "zai-test-key",
        timeoutMs: 1500,
        fetchFn: async () => streamed.response,
      }),
    ).rejects.toThrow("Z.AI video description failed: JSON response exceeds 16777216 bytes");

    expect(streamed.getReadCount()).toBeLessThan(64);
    expect(streamed.wasCanceled()).toBe(true);
  });
});
