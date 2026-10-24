import { createServer, type Server } from "node:http";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { expect, it } from "vitest";
import { listenOnLoopback as listenLoopbackServer } from "../test-support/hanging-loopback-server.js";
import googlePlugin from "./index.js";
import { describeGeminiVideo, transcribeGeminiAudio } from "./media-understanding-provider.js";

installPinnedHostnameTestHooks();
const LOOPBACK_RESPONSE_BYTES = 18 * 1024 * 1024;

function createOversizedJsonServer(): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((_req, res) => {
    let sentBytes = 0;
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    res.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => {
      if (sentBytes >= LOOPBACK_RESPONSE_BYTES) {
        clearInterval(timer);
        res.end();
        return;
      }
      sentBytes += chunk.length;
      res.write(chunk);
    }, 1);
    res.on("close", () => {
      clearInterval(timer);
      resolveClosed(sentBytes);
    });
  });
  return { server, closed };
}

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

it.each([undefined, "override"])("builds the request with API key override %s", async (apiKey) => {
  const { fetchFn, getRequest } = createRequestCaptureJsonFetch(
    mediaResponse("first", " second ", ""),
  );

  const result = await describeVideo({
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
    model: "gemini-3-pro",
    headers: { "X-Other": "1", ...(apiKey ? { "X-Goog-Api-Key": apiKey } : {}) },
    fetchFn,
  });
  const { url: seenUrl, init: seenInit } = getRequest();

  expect(result).toMatchObject({ model: "gemini-3.1-pro-preview", text: "first\nsecond" });
  expect(seenUrl).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent",
  );
  expect(seenInit).toMatchObject({ method: "POST", signal: expect.any(AbortSignal) });

  const headers = new Headers(seenInit?.headers);
  expect(Object.fromEntries(headers)).toMatchObject({
    "x-goog-api-key": apiKey ?? "test-key",
    "content-type": "application/json",
    "x-other": "1",
  });

  const bodyText = seenInit?.body;
  if (typeof bodyText !== "string") {
    throw new Error("Expected a JSON string request body");
  }
  const body = JSON.parse(bodyText);
  expect(body.contents?.[0]?.parts).toMatchObject([
    { text: "Describe the video." },
    { inline_data: { mime_type: "video/mp4", data: mediaRequest.buffer.toString("base64") } },
  ]);
});

it.each([
  { method: "describeVideo", baseUrl: "", fileName: "clip.mp4" },
  { method: "transcribeAudio", baseUrl: "   ", fileName: "clip.wav" },
] as const)(
  "uses the canonical endpoint for blank $method base URLs through registration",
  async ({ method, baseUrl, fileName }) => {
    const captured = createCapturedPluginRegistration({ id: "google" });
    googlePlugin.register(captured.api);
    const handler = captured.mediaUnderstandingProviders.find(
      (provider) => provider.id === "google",
    )?.[method];
    if (!handler) {
      throw new Error(`Expected registered Google ${method}`);
    }
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch(mediaResponse("media ok"));

    const result = await handler({ ...mediaRequest, fileName, baseUrl, fetchFn });

    const { url, init } = getRequest();
    expect(result.text).toBe("media ok");
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
    );
    expect(new Headers(init?.headers).get("x-goog-api-client")).toMatch(/^openclaw\//u);
  },
);

it("bounds oversized video JSON responses and closes the stream early", async () => {
  const { server, closed } = createOversizedJsonServer();
  const port = await listenLoopbackServer(server);
  const fetchFn = withFetchPreconnect(async () =>
    fetch(`http://127.0.0.1:${port}/google-video-json`),
  );

  try {
    await expect(describeVideo({ fetchFn })).rejects.toThrow(
      /JSON response exceeds 16777216 bytes/u,
    );
    await expect(closed).resolves.toBeLessThan(LOOPBACK_RESPONSE_BYTES);
  } finally {
    server.close();
  }
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
