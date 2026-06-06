import { installPinnedHostnameTestHooks } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SENSEAUDIO_TTS_BASE_URL,
  DEFAULT_SENSEAUDIO_TTS_MODEL,
  DEFAULT_SENSEAUDIO_TTS_VOICE,
  listSenseAudioSystemVoices,
  normalizeSenseAudioTtsBaseUrl,
  senseAudioTTS,
} from "./tts.js";

installPinnedHostnameTestHooks();

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { ...init, headers });
}

function readJsonBody(init: RequestInit | undefined): unknown {
  return JSON.parse((init?.body ?? "") as string);
}

function readUrl(call: unknown): string {
  const [url] = call as [string | URL, RequestInit];
  return typeof url === "string" ? url : url.toString();
}

function readInit(call: unknown): RequestInit {
  const [, init] = call as [string | URL, RequestInit];
  return init;
}

describe("senseAudioTTS", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function defaults(overrides: Partial<Parameters<typeof senseAudioTTS>[0]> = {}) {
    return {
      text: "你好",
      apiKey: "test-key",
      baseUrl: DEFAULT_SENSEAUDIO_TTS_BASE_URL,
      model: DEFAULT_SENSEAUDIO_TTS_MODEL,
      voiceId: DEFAULT_SENSEAUDIO_TTS_VOICE,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  it("sends the documented default request body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { audio: "aabb" },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const buf = await senseAudioTTS(defaults());

    expect(buf.toString("hex")).toBe("aabb");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readUrl(fetchMock.mock.calls[0])).toBe("https://api.senseaudio.cn/v1/t2a_v2");

    const init = readInit(fetchMock.mock.calls[0]);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(headers.get("content-type")).toBe("application/json");

    expect(readJsonBody(init)).toEqual({
      model: DEFAULT_SENSEAUDIO_TTS_MODEL,
      text: "你好",
      stream: false,
      voice_setting: { voice_id: DEFAULT_SENSEAUDIO_TTS_VOICE },
      audio_setting: {
        sample_rate: 32_000,
        bitrate: 128_000,
        format: "mp3",
        channel: 2,
      },
    });
  });

  it("forwards custom model and voiceId into the request body", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { audio: "00" },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await senseAudioTTS(defaults({ model: "custom-model", voiceId: "custom-voice" }));

    const init = readInit(fetchMock.mock.calls[0]);
    const body = readJsonBody(init) as {
      model: string;
      voice_setting: { voice_id: string };
    };
    expect(body.model).toBe("custom-model");
    expect(body.voice_setting.voice_id).toBe("custom-voice");
  });

  it("throws when the HTTP status is not 2xx", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("nope", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(senseAudioTTS(defaults())).rejects.toThrow(/SenseAudio TTS API error/i);
  });

  it("throws when base_resp.status_code is non-zero, surfacing status_msg", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { audio: "" },
        base_resp: { status_code: 1004, status_msg: "invalid api key" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(senseAudioTTS(defaults())).rejects.toThrow(/invalid api key/);
  });

  it("throws when data.audio is missing", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {},
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(senseAudioTTS(defaults())).rejects.toThrow(/no audio data/i);
  });

  it("decodes the hex audio payload into a Buffer", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: { audio: "48656c6c6f" },
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const buf = await senseAudioTTS(defaults());
    expect(buf.equals(Buffer.from("Hello"))).toBe(true);
  });
});

describe("listSenseAudioSystemVoices", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function defaults(overrides: Partial<Parameters<typeof listSenseAudioSystemVoices>[0]> = {}) {
    return {
      apiKey: "test-key",
      baseUrl: DEFAULT_SENSEAUDIO_TTS_BASE_URL,
      timeoutMs: 5_000,
      ...overrides,
    };
  }

  it("posts voice_type=system to /v1/get_voice with bearer auth", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        system_voice: [],
        voice_cloning: [],
        voice_generation: [],
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const voices = await listSenseAudioSystemVoices(defaults());
    expect(voices).toEqual([]);

    expect(readUrl(fetchMock.mock.calls[0])).toBe("https://api.senseaudio.cn/v1/get_voice");
    const init = readInit(fetchMock.mock.calls[0]);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key");
    expect(readJsonBody(init)).toEqual({ voice_type: "system" });
  });

  it("maps only system_voice; drops cloning and generation entries", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        system_voice: [
          {
            voice_id: "female_0033_b",
            voice_name: "Standard Female 33",
            description: ["warm", "Chinese"],
            created_time: "2026-01-01",
          },
          {
            voice_id: "",
            voice_name: "should-skip",
            description: [],
            created_time: "2026-01-01",
          },
        ],
        voice_cloning: [
          {
            voice_id: "clone-1",
            voice_name: "Clone 1",
            description: [],
            created_time: "2026-01-01",
          },
        ],
        voice_generation: [
          {
            voice_id: "gen-1",
            voice_name: "Gen 1",
            description: [],
            created_time: "2026-01-01",
          },
        ],
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const voices = await listSenseAudioSystemVoices(defaults());
    expect(voices).toEqual([
      {
        id: "female_0033_b",
        name: "Standard Female 33",
        category: "system",
        description: "warm, Chinese",
      },
    ]);
  });

  it("treats empty description arrays as undefined description", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        system_voice: [
          {
            voice_id: "v1",
            voice_name: "V1",
            description: [],
            created_time: "2026-01-01",
          },
        ],
        voice_cloning: [],
        voice_generation: [],
        base_resp: { status_code: 0, status_msg: "ok" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const [voice] = await listSenseAudioSystemVoices(defaults());
    expect(voice).toEqual({ id: "v1", name: "V1", category: "system" });
  });

  it("throws when base_resp.status_code is non-zero", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        system_voice: [],
        voice_cloning: [],
        voice_generation: [],
        base_resp: { status_code: 1002, status_msg: "rate limited" },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(listSenseAudioSystemVoices(defaults())).rejects.toThrow(/rate limited/);
  });
});

describe("normalizeSenseAudioTtsBaseUrl", () => {
  it("returns the default when undefined or empty", () => {
    expect(normalizeSenseAudioTtsBaseUrl()).toBe(DEFAULT_SENSEAUDIO_TTS_BASE_URL);
    expect(normalizeSenseAudioTtsBaseUrl("")).toBe(DEFAULT_SENSEAUDIO_TTS_BASE_URL);
    expect(normalizeSenseAudioTtsBaseUrl("   ")).toBe(DEFAULT_SENSEAUDIO_TTS_BASE_URL);
  });

  it("strips trailing slashes and a trailing /v1 segment", () => {
    expect(normalizeSenseAudioTtsBaseUrl("https://example.com/")).toBe("https://example.com");
    expect(normalizeSenseAudioTtsBaseUrl("https://example.com/v1")).toBe("https://example.com");
    expect(normalizeSenseAudioTtsBaseUrl("https://example.com/v1/")).toBe("https://example.com");
  });
});
