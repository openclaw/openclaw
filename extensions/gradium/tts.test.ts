import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SpeechSynthesisRequest } from "openclaw/plugin-sdk/speech";
import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { buildGradiumSpeechProvider } from "./speech-provider.js";

describe("gradium tts diagnostics", () => {
  installPinnedHostnameTestHooks();

  const provider = buildGradiumSpeechProvider();
  const request: SpeechSynthesisRequest = {
    text: "hello",
    cfg: {},
    providerConfig: {
      apiKey: "test-key",
      baseUrl: "https://api.gradium.ai",
      voiceId: "YTpq7expH9539ERJ",
    },
    target: "audio-file",
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

    await expect(provider.synthesize(request)).rejects.toThrow(
      "Gradium API error (401): Invalid API key [request_id=grad_req_123]",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts the active credential from provider diagnostics", async () => {
    const credential = "opaque-gradium-secret42";
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: `provider diagnostic ${credential}` }, { status: 401 }),
        ),
    );
    const error: unknown = await provider
      .synthesize({
        ...request,
        providerConfig: { ...request.providerConfig, apiKey: credential },
      })
      .catch((cause: unknown) => cause);
    assert(error instanceof Error);
    expect(formatErrorMessage(error)).not.toContain(credential);
    expect(error.message).toContain("provider diagnostic");
    expect(error).toMatchObject({ status: 401, statusCode: 401 });
  });

  it("includes raw non-JSON error detail while capping streamed body reads", async () => {
    const streamed = createStreamingResponse({
      status: 503,
      chunkCount: 200,
      chunkSize: 1024,
      byte: 121,
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(streamed.response));

    await expect(provider.synthesize(request)).rejects.toThrow("Gradium API error (503): yyyy");

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

    await expect(
      provider.synthesize({
        ...request,
        providerConfig: { ...request.providerConfig, baseUrl },
      }),
    ).rejects.toThrow(expectedError);

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

    await expect(provider.synthesize(request)).rejects.toThrow(
      "Gradium API error: malformed audio response",
    );
  });
});
