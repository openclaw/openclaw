import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeOpenAiAudioWithContext } from "./audio-transcription.js";

const { lookupMock, resolveAuthMock } = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  resolveAuthMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: resolveAuthMock,
}));

type AudioContext = Parameters<
  NonNullable<MediaUnderstandingProvider["transcribeAudioWithContext"]>
>[0];

function createContext(overrides: Partial<AudioContext> = {}): AudioContext {
  return {
    cfg: {},
    buffer: Buffer.from("synthetic audio"),
    fileName: "voice.ogg",
    mime: "audio/ogg",
    timeoutMs: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  for (const name of [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    vi.stubEnv(name, "");
  }
  lookupMock.mockResolvedValue([{ address: "240.0.0.37", family: 4 }]);
  resolveAuthMock.mockResolvedValue({
    apiKey: "test-oauth-token",
    source: "profile:openai:test",
    mode: "oauth",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI OAuth audio network policy", () => {
  it("honors the trusted private-network opt-in through the real transcription transport", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ text: "One two three" }), { status: 200 }));
    const result = await transcribeOpenAiAudioWithContext(
      createContext({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        request: { allowPrivateNetwork: true },
        fetchFn,
      }),
    );

    expect(result).toEqual({
      ok: true,
      value: { text: "One two three", model: "gpt-4o-transcribe" },
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    expect(requestUrl).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-oauth-token");
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it.each([undefined, {}, { allowPrivateNetwork: false }])(
    "keeps special-use DNS blocked without opt-in (%j)",
    async (request) => {
      const fetchFn = vi.fn<typeof fetch>();
      await expect(
        transcribeOpenAiAudioWithContext(createContext({ request, fetchFn })),
      ).rejects.toThrow(/private|special.use|blocked/i);
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it.each<Partial<AudioContext>>([
    { baseUrl: "https://proxy.example/v1" },
    { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { headers: { "X-Custom": "value" } },
    { request: { allowPrivateNetwork: true, headers: { "X-Custom": "value" } } },
    { request: { allowPrivateNetwork: true, auth: { mode: "provider-default" } } },
    { request: { allowPrivateNetwork: true, proxy: { mode: "env-proxy" } } },
    { request: { allowPrivateNetwork: true, tls: { insecureSkipVerify: true } } },
  ])(
    "rejects endpoint and credential transport overrides before uploading (%j)",
    async (overrides) => {
      const fetchFn = vi.fn<typeof fetch>();
      const result = await transcribeOpenAiAudioWithContext(
        createContext({
          request: { allowPrivateNetwork: true },
          ...overrides,
          fetchFn,
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(String(result.error)).toContain("official endpoint");
      }
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});
