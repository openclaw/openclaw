import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-media-understanding";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../test-support/streaming-error-response.js";
import { SPEECHIFY_CALLER, SPEECHIFY_CALLER_VERSION } from "./shared.js";
import { listSpeechifyVoices, speechifyTts } from "./tts.js";

describe("speechify tts diagnostics", () => {
  installPinnedHostnameTestHooks();

  const request: Parameters<typeof speechifyTts>[0] = {
    text: "hello",
    apiKey: "sk_test",
    baseUrl: "https://api.speechify.ai",
    voiceId: "geffen_32",
    model: "simba-3.2",
    format: "mp3",
    timeoutMs: 5_000,
    maxBytes: 16 * 1024 * 1024,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("includes parsed provider detail, code and request id for JSON API errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: {
            code: "bad_request",
            message: 'simba-3.2 supports English voices only (voice locale: "pt-BR").',
          },
          request_id: "ce6bb08b8c91ef8be8627ef1",
        },
        { status: 400, headers: { "x-request-id": "ce6bb08b8c91ef8be8627ef1" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(speechifyTts(request)).rejects.toThrow(
      'Speechify API error (400): simba-3.2 supports English voices only (voice locale: "pt-BR"). [code=bad_request] [request_id=ce6bb08b8c91ef8be8627ef1]',
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

    await expect(speechifyTts(request)).rejects.toThrow("Speechify API error (503): yyyy");

    expect(streamed.getReadCount()).toBeLessThan(200);
  });

  it.each([
    {
      name: "rejects HTTP base URLs before sending the API key",
      baseUrl: "http://api.speechify.ai",
      expectedError: "Speechify baseUrl must use https",
    },
    {
      name: "rejects hostname suffix lookalikes before sending the API key",
      baseUrl: "https://api.speechify.ai.example.com",
      expectedError: "Speechify baseUrl must target api.speechify.ai",
    },
  ])("$name", async ({ baseUrl, expectedError }) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(speechifyTts({ ...request, baseUrl })).rejects.toThrow(expectedError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the legacy API hostname", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await speechifyTts({ ...request, baseUrl: "https://api.sws.speechify.com/" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.sws.speechify.com/v1/audio/stream");
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

    await expect(speechifyTts(request)).rejects.toThrow(
      "Speechify API error: malformed audio response",
    );
  });

  it("identifies the integration on every request, in the form Speechify accepts", async () => {
    // Values outside these sets are dropped whole on the Speechify side, which
    // would make the plugin's traffic invisible rather than mislabelled.
    expect(SPEECHIFY_CALLER).toMatch(/^[a-z0-9._-]{1,40}$/);
    expect(SPEECHIFY_CALLER_VERSION).toMatch(/^[A-Za-z0-9._+-]{1,32}$/);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from("audio"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await speechifyTts(request);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers);
    expect(headers.get("speechify-caller")).toBe("openclaw");
    expect(headers.get("speechify-caller-version")).toBe(SPEECHIFY_CALLER_VERSION);
  });

  it("accepts the raw PCM content type the API sends for telephony", async () => {
    const pcm = Buffer.alloc(480);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(pcm, {
          status: 200,
          headers: { "content-type": "audio/L16;rate=24000;channels=1" },
        }),
      ),
    );

    const audio = await speechifyTts({ ...request, format: "pcm" });

    expect(audio.byteLength).toBe(480);
  });
});

describe("speechify voices", () => {
  installPinnedHostnameTestHooks();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const params = { apiKey: "sk_test", baseUrl: "https://api.speechify.ai", timeoutMs: 5_000 };

  it("maps the voice catalog array into voice options", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: "geffen_32",
          display_name: "Geffen",
          locale: "en-US",
          gender: "male",
          type: "shared",
          tags: ["narration"],
          models: [{ name: "simba-3.2" }, { name: "simba-english" }],
        },
        { display_name: "no id, dropped" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const voices = await listSpeechifyVoices(params);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.speechify.ai/v1/voices");
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk_test");
    expect(headers.get("speechify-caller")).toBe(SPEECHIFY_CALLER);
    expect(headers.get("speechify-caller-version")).toBe(SPEECHIFY_CALLER_VERSION);
    expect(voices).toEqual([
      {
        id: "geffen_32",
        name: "Geffen",
        description: "Models: simba-3.2, simba-english",
        category: "shared",
        locale: "en-US",
        gender: "male",
        personalities: ["narration"],
      },
    ]);
  });

  it("follows a paginated catalog until has_more is false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ voices: [{ id: "a" }], next_cursor: "c2", has_more: true }),
      )
      .mockResolvedValueOnce(Response.json({ voices: [{ id: "b" }], has_more: false }));
    vi.stubGlobal("fetch", fetchMock);

    const voices = await listSpeechifyVoices(params);

    expect(voices.map((voice) => voice.id)).toEqual(["a", "b"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api.speechify.ai/v1/voices?cursor=c2");
  });
});
