import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { oversizedJsonResponse } from "openclaw/plugin-sdk/test-fixtures";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { assert, expect, it } from "vitest";
import googlePlugin from "./index.js";
import { describeGeminiVideo, transcribeGeminiAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();

const mediaRequest = {
  buffer: Buffer.from("video-bytes"),
  fileName: "clip.mp4",
  apiKey: "test-key",
  timeoutMs: 1500,
};
const describeVideo = (overrides: Partial<Parameters<typeof describeGeminiVideo>[0]> = {}) =>
  describeGeminiVideo({ ...mediaRequest, ...overrides });

const mediaResponse = (...texts: string[]) => ({
  candidates: [{ content: { parts: texts.map((text) => ({ text })) } }],
});
const origin = "https://generativelanguage.googleapis.com/v1beta";
it.each([
  { method: "describeVideo", baseUrl: "", mime: "video/mp4" },
  {
    method: "describeVideo",
    baseUrl: `${origin}/`,
    mime: "video/mp4",
    model: "gemini-3-pro",
    apiKey: "override",
  },
  { method: "transcribeAudio", baseUrl: "   ", mime: "audio/wav" },
] as const)("builds registered $method requests at '$baseUrl'", async (row) => {
  const { method, baseUrl, mime } = row;
  const model = "model" in row ? row.model : undefined;
  const apiKey = "apiKey" in row ? row.apiKey : undefined;
  const captured = createCapturedPluginRegistration({ id: "google" });
  googlePlugin.register(captured.api);
  const handler = captured.mediaUnderstandingProviders.find(
    (provider) => provider.id === "google",
  )?.[method];
  assert(handler, `Expected registered Google ${method}`);
  const { fetchFn, getRequest } = createRequestCaptureJsonFetch(
    mediaResponse("first", " second ", ""),
  );
  const result = await handler({
    ...mediaRequest,
    baseUrl,
    model,
    fetchFn,
    fileName: method === "describeVideo" ? "clip.mp4" : "clip.wav",
    headers: { "X-Other": "1", ...(apiKey ? { "X-Goog-Api-Key": apiKey } : {}) },
  });
  const expectedModel = model ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
  const { url, init } = getRequest();
  expect(result).toMatchObject({ model: expectedModel, text: "first\nsecond" });
  expect(url).toBe(`${origin}/models/${expectedModel}:generateContent`);
  expect(init).toMatchObject({ method: "POST", signal: expect.any(AbortSignal) });
  expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
    "x-goog-api-key": apiKey ?? "test-key",
    "content-type": "application/json",
    "x-other": "1",
    "x-goog-api-client": expect.stringMatching(/^openclaw\//u),
  });
  assert(typeof init?.body === "string", "Expected a JSON string request body");
  expect(JSON.parse(init.body).contents?.[0]?.parts).toMatchObject([
    { text: method === "describeVideo" ? "Describe the video." : "Transcribe the audio." },
    { inline_data: { mime_type: mime, data: mediaRequest.buffer.toString("base64") } },
  ]);
});

it("bounds oversized video JSON responses and closes the stream early", async () => {
  const body = oversizedJsonResponse({ chunkCount: 288, chunkSize: 64 * 1024 });
  await expect(describeVideo({ fetchFn: async () => body.response })).rejects.toThrow(
    /JSON response exceeds 16777216 bytes/u,
  );
  expect(body.getReadCount()).toBeLessThan(288);
  expect(body.wasCanceled()).toBe(true);
});

it("rejects non-Google video base URLs before sending authenticated requests", async () => {
  await expect(
    describeVideo({
      baseUrl: "https://example.com/v1beta/",
      fetchFn: async () => {
        throw new Error("fetch should not run");
      },
    }),
  ).rejects.toThrow(
    "Google Generative AI baseUrl must use https://generativelanguage.googleapis.com",
  );
});

it("formats Google audio transcription HTTP errors with provider details", async () => {
  await expect(
    transcribeGeminiAudio({
      ...mediaRequest,
      fileName: "clip.wav",
      fetchFn: async () =>
        Response.json(
          { error: { message: "Unsupported audio", status: "INVALID_ARGUMENT" } },
          { status: 400, headers: { "x-request-id": "google_audio_req" } },
        ),
    }),
  ).rejects.toThrow(
    "Audio transcription failed (400): Unsupported audio [code=INVALID_ARGUMENT] [request_id=google_audio_req]",
  );
});

it("redacts the actual request credential from Google media errors", async () => {
  const credential = "fixture-google-opaque-credential";
  const failure = describeVideo({
    headers: { "X-Goog-Api-Key": credential },
    fetchFn: async () =>
      Response.json({ error: { message: `Rejected ${credential}` } }, { status: 400 }),
  });

  await expect(failure).rejects.toMatchObject({ status: 400, statusCode: 400 });
  await expect(failure).rejects.not.toThrow(credential);
});
