import {
  capturePluginRegistration,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { assert, expect, it } from "vitest";
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
assert(describeQwenVideo, "expected Qwen video description capability");

it("uses a currently served multimodal default", () => {
  expect(qwenProvider.defaultModels).toEqual({ image: "qwen3.6-plus", video: "qwen3.6-plus" });
});
it("builds the expected OpenAI-compatible video payload", async () => {
  const { fetchFn, getRequest } = createRequestCaptureJsonFetch({
    choices: [{ message: { content: [{ text: " first " }, { text: "second" }] } }],
  });

  const result = await describeQwenVideo({
    ...videoRequest,
    model: "qwen-vl-max",
    prompt: "summarize the clip",
    headers: { "X-Other": "1" },
    fetchFn,
  });
  const { url, init } = getRequest();

  expect(result).toMatchObject({ model: "qwen-vl-max", text: "first\nsecond" });
  expect(url).toBe("https://example.com/v1/chat/completions");
  assert(init, "expected Qwen request init");
  expect(init.method).toBe("POST");
  expect(init.signal).toBeInstanceOf(AbortSignal);

  expect(Object.fromEntries(new Headers(init.headers))).toMatchObject({
    authorization: "Bearer test-key",
    "content-type": "application/json",
    "x-other": "1",
  });

  assert(typeof init.body === "string" || Buffer.isBuffer(init.body));
  const body = JSON.parse(init.body.toString());
  expect({ model: body.model, messages: body.messages }).toEqual({
    model: "qwen-vl-max",
    messages: [
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
    ],
  });
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
