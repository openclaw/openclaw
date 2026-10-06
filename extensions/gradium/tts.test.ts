import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { gradiumTTS } from "./tts.js";

describe("gradium tts diagnostics", () => {
  installPinnedHostnameTestHooks();

  const request: Parameters<typeof gradiumTTS>[0] = {
    text: "hello",
    apiKey: "test-key",
    baseUrl: "https://api.gradium.ai",
    voiceId: "YTpq7expH9539ERJ",
    outputFormat: "wav",
    timeoutMs: 5_000,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail and request id for JSON API errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { message: "Invalid API key" },
          { status: 401, headers: { "x-request-id": "grad_req_123" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(gradiumTTS(request)).rejects.toThrow(
      "Gradium API error (401): Invalid API key [request_id=grad_req_123]",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("includes raw non-JSON error detail while capping streamed body reads", async () => {
    const streamed = createStreamingResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(gradiumTTS(request)).rejects.toThrow("Gradium API error (503): yyyy");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it.each([
    {
      name: "rejects HTTP base URLs before sending the API key",
      baseUrl: "http://api.gradium.ai",
      expectedError: "Gradium baseUrl must use https",
    },
    {
      name: "rejects hostname suffix lookalikes before sending the API key",
      baseUrl: "https://api.gradium.ai.example.com",
      expectedError: "Gradium baseUrl must target api.gradium.ai",
    },
  ])("$name", async ({ baseUrl, expectedError }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(gradiumTTS({ ...request, baseUrl })).rejects.toThrow(expectedError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "JSON error", contentType: "application/json", body: '{"error":"denied"}' },
    { name: "empty audio", contentType: "audio/mpeg", body: "" },
  ])("rejects a successful $name response as synthesized audio", async ({ contentType, body }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { "content-type": contentType } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(gradiumTTS(request)).rejects.toThrow(
      "Gradium API error: malformed audio response",
    );
  });
});
