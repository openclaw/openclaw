import {
  getProviderHttpMocks,
  installProviderHttpMockCleanup,
  requireFirstPostJsonRecordRequest,
} from "openclaw/plugin-sdk/provider-http-test-mocks";
import { afterEach, expect, it, vi } from "vitest";
import { buildVercelAiGatewaySpeechProvider } from "./speech-provider.js";

const transcode = vi.hoisted(() => vi.fn(async () => Buffer.from("opus-bytes")));
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>()),
  transcodeAudioBufferToOpus: transcode,
}));

const { postJsonRequestMock } = getProviderHttpMocks();

installProviderHttpMockCleanup();

const MP3 = Buffer.concat([
  Buffer.from("ID3"),
  Buffer.from([3, 0, 0, 0, 0, 0, 0]),
  Buffer.alloc(64),
]);
const OGG = Buffer.concat([
  Buffer.from("OggS"),
  Buffer.alloc(24),
  Buffer.from("OpusHead"),
  Buffer.alloc(32),
]);

const context = {
  isProviderAuthProfileConfigured: vi.fn(() => false),
  isProviderAuthProfileConfiguredAsync: vi.fn(async () => false),
  resolveApiKeyForProvider: vi.fn(async () => ({
    apiKey: "vck_profile",
    source: "profile:vercel-ai-gateway:default",
    mode: "api-key" as const,
  })),
};
const provider = buildVercelAiGatewaySpeechProvider(context);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function respond(body: unknown = { audio: MP3.toString("base64") }, status = 200) {
  const release = vi.fn(async () => {});
  postJsonRequestMock.mockResolvedValue({
    response: new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    release,
  });
  return release;
}

function synthesize(overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {}) {
  return provider.synthesize({
    text: "Hello from OpenClaw",
    cfg: {},
    providerConfig: {},
    target: "audio-file",
    timeoutMs: 12_000,
    ...overrides,
  });
}

it("posts text to the native AI Gateway speech endpoint and decodes the base64 audio", async () => {
  const release = respond({ audio: MP3.toString("base64"), warnings: [] });

  await expect(synthesize()).resolves.toEqual({
    audioBuffer: MP3,
    outputFormat: "mp3",
    fileExtension: ".mp3",
    voiceCompatible: false,
  });

  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "TTS request");
  expect(request.url).toBe("https://ai-gateway.vercel.sh/v4/ai/speech-model");
  expect(request.body).toEqual({ text: "Hello from OpenClaw" });
  expect(request.timeoutMs).toBe(12_000);
  const headers = request.headers;
  if (!(headers instanceof Headers)) {
    throw new Error("expected request headers");
  }
  expect(Object.fromEntries(headers)).toMatchObject({
    authorization: "Bearer vck_profile",
    "content-type": "application/json",
    "ai-gateway-protocol-version": "0.0.1",
    "ai-gateway-auth-method": "api-key",
    "ai-speech-model-specification-version": "4",
    "ai-model-id": "openai/tts-1",
  });
  expect(context.resolveApiKeyForProvider).toHaveBeenCalledWith({
    provider: "vercel-ai-gateway",
    cfg: {},
  });
  expect(release).toHaveBeenCalledOnce();
});

it("sends configured speech options, with directive overrides winning", async () => {
  respond();
  const providerConfig = provider.resolveConfig!({
    cfg: {},
    timeoutMs: 12_000,
    rawConfig: {
      providers: {
        "vercel-ai-gateway": {
          apiKey: "vck_tts",
          model: "openai/tts-1-hd",
          speakerVoice: "nova",
          speed: 1.25,
          language: "en",
          instructions: "Speak warmly.",
          responseFormat: "WAV",
        },
      },
    },
  });

  await synthesize({
    providerConfig,
    providerOverrides: { model: "elevenlabs/eleven-v3", voice: "Rachel" },
  });

  const request = requireFirstPostJsonRecordRequest(postJsonRequestMock, "TTS request");
  expect(request.body).toEqual({
    text: "Hello from OpenClaw",
    voice: "Rachel",
    outputFormat: "wav",
    instructions: "Speak warmly.",
    speed: 1.25,
    language: "en",
  });
  const headers = request.headers instanceof Headers ? request.headers : undefined;
  expect(headers?.get("ai-model-id")).toBe("elevenlabs/eleven-v3");
  expect(headers?.get("authorization")).toBe("Bearer vck_tts");
  expect(context.resolveApiKeyForProvider).not.toHaveBeenCalled();
});

it("keeps Ogg/Opus audio as a native voice note", async () => {
  respond({ audio: OGG.toString("base64") });
  await expect(synthesize({ target: "voice-note" })).resolves.toEqual({
    audioBuffer: OGG,
    outputFormat: "ogg",
    fileExtension: ".ogg",
    voiceCompatible: true,
  });
  expect(transcode).not.toHaveBeenCalled();
});

it("transcodes other formats to Opus for voice notes", async () => {
  respond();
  await expect(synthesize({ target: "voice-note" })).resolves.toEqual({
    audioBuffer: Buffer.from("opus-bytes"),
    outputFormat: "opus",
    fileExtension: ".opus",
    voiceCompatible: true,
  });
  expect(transcode).toHaveBeenCalledWith({
    audioBuffer: MP3,
    inputExtension: "mp3",
    tempPrefix: "tts-vercel-ai-gateway-",
    timeoutMs: 12_000,
  });
});

it.each([
  { body: { warnings: [] }, status: 200, error: "malformed base64 audio" },
  { body: { audio: "not base64!" }, status: 200, error: "malformed base64 audio" },
  { body: '{"error":{"message":"bad key"}}', status: 401, error: "speech synthesis failed" },
])("rejects status $status response $body", async ({ body, status, error }) => {
  respond(body, status);
  await expect(synthesize()).rejects.toThrow(error);
});

it.each([
  { name: "TTS key", providerConfig: { apiKey: "vck_tts" }, cfg: {}, env: undefined },
  { name: "AI_GATEWAY_API_KEY", providerConfig: {}, cfg: {}, env: "vck_env" },
  {
    name: "models.providers key",
    providerConfig: {},
    cfg: {
      models: {
        providers: {
          "vercel-ai-gateway": {
            baseUrl: "https://ai-gateway.vercel.sh",
            models: [],
            apiKey: "vck_cfg",
          },
        },
      },
    },
    env: undefined,
  },
])("is configured from the $name without reading auth profiles", async (entry) => {
  vi.stubEnv("AI_GATEWAY_API_KEY", entry.env);
  const ctx = { cfg: entry.cfg, providerConfig: entry.providerConfig, timeoutMs: 1 };
  expect(provider.isConfigured(ctx)).toBe(true);
  await expect(provider.isConfiguredAsync!(ctx)).resolves.toBe(true);
  expect(context.isProviderAuthProfileConfiguredAsync).not.toHaveBeenCalled();
});

it("falls back to the chat auth profile for readiness", async () => {
  vi.stubEnv("AI_GATEWAY_API_KEY", undefined);
  const ctx = { cfg: {}, providerConfig: {}, timeoutMs: 1 };
  await expect(provider.isConfiguredAsync!(ctx)).resolves.toBe(false);
  context.isProviderAuthProfileConfiguredAsync.mockResolvedValueOnce(true);
  await expect(provider.isConfiguredAsync!(ctx)).resolves.toBe(true);
  expect(context.isProviderAuthProfileConfiguredAsync).toHaveBeenCalledWith({
    provider: "vercel-ai-gateway",
    cfg: {},
  });
});
