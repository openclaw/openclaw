import { inspect } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import type { AudioTranscriptionRequest } from "openclaw/plugin-sdk/media-understanding";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
// Keep static: evaluates the partial auth mock and its compiled workers at collection.
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import {
  createRequestCaptureJsonFetch,
  installPinnedHostnameTestHooks,
} from "openclaw/plugin-sdk/test-media-understanding";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: vi.fn(),
}));
const authMocks = { resolve: vi.mocked(resolveApiKeyForProvider) };
const audio = { buffer: Buffer.from("audio"), fileName: "voice.wav", timeoutMs: 1000 };
const transcribeWithContext = (
  overrides: Partial<
    Parameters<NonNullable<typeof openaiMediaUnderstandingProvider.transcribeAudioWithContext>>[0]
  > = {},
) =>
  openaiMediaUnderstandingProvider.transcribeAudioWithContext!({ cfg: {}, ...audio, ...overrides });
const transcribe = (overrides: Partial<AudioTranscriptionRequest>) =>
  openaiMediaUnderstandingProvider.transcribeAudio!({ ...audio, apiKey: "test-key", ...overrides });
const isConfigured = openaiMediaUnderstandingProvider.isAudioConfigured!;
const useAuth = (apiKey: string, mode: "api-key" | "oauth", source = "profile:openai:audio") =>
  authMocks.resolve.mockResolvedValue({ apiKey, mode, source });
const makeConfig = (apiKey: string | undefined, baseUrl: string, profiles: string[]) => ({
  auth: { order: { openai: profiles } },
  models: { providers: { openai: { apiKey, baseUrl, models: [] } } },
});
function expectForm(init: RequestInit | undefined, fields: Record<string, string>) {
  const body = expectDefined(init?.body, "transcription request body") as FormData;
  for (const [key, value] of Object.entries(fields)) {
    expect(body.get(key)).toBe(value);
  }
}

installPinnedHostnameTestHooks();

beforeEach(() => {
  authMocks.resolve.mockReset();
});

describe("openaiMediaUnderstandingProvider", () => {
  it("declares audio support with the transcription default", () => {
    expect(openaiMediaUnderstandingProvider.capabilities).toEqual(["image", "audio"]);
    expect(openaiMediaUnderstandingProvider.defaultModels).toEqual({
      image: "gpt-6-astra",
      audio: "gpt-4o-transcribe",
    });
    expect(openaiMediaUnderstandingProvider.autoPriority).toEqual({ image: 20, audio: 20 });
    expect(openaiMediaUnderstandingProvider.transcribeAudio).toBeTypeOf("function");
  });
});

describe("provider-owned audio transcription", () => {
  const token = "fixture-oauth-token";

  it.each([
    [undefined, undefined],
    ["https://api.openai.com", "gpt-4o-mini-transcribe"],
    ["https://chatgpt.com/backend-api/codex", "gpt-4o-mini-transcribe"],
  ])(
    "routes subscription audio from official base %s with model %s to the standard transcription endpoint",
    async (baseUrl, model) => {
      useAuth(token, "oauth");
      const context = {
        cfg: {},
        agentDir: "/fixture/agents/audio",
        profile: "openai:audio",
        baseUrl,
        model,
      };
      expect(await isConfigured(context)).toBe(true);
      authMocks.resolve.mockClear();
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "Hallo" });
      const result = await transcribeWithContext({
        ...context,
        language: "de",
        prompt: "Names: Ada",
        fetchFn,
      });
      const { url, init } = getRequest();
      expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).has("ChatGPT-Account-ID")).toBe(false);
      expectForm(init, {
        language: "de",
        model: model ?? "gpt-4o-transcribe",
        prompt: "Names: Ada",
      });
      expect(result).toEqual({
        ok: true,
        value: { text: "Hallo", model: model ?? "gpt-4o-transcribe" },
      });
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: "/fixture/agents/audio",
          profileId: "openai:audio",
          lockedProfile: true,
        }),
      );
    },
  );

  it.each([undefined, " \t "])(
    "skips SIWC for subscription transcription through the registered provider with absent key %j",
    async (apiKey) =>
      withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
        const [
          { createPluginRegistryFixture },
          { createCapturedPluginRegistration, createPluginRecord },
          { withPluginRuntimeRegistryScope },
          { default: plugin },
        ] = await Promise.all([
          import("openclaw/plugin-sdk/plugin-test-contracts"),
          import("openclaw/plugin-sdk/plugin-test-runtime"),
          import("openclaw/plugin-sdk/channel-test-helpers"),
          import("./index.js"),
        ]);
        const cfg = makeConfig(apiKey, "https://api.openai.com/v1", [
          "openai:siwc",
          "openai:fixture-subscription",
        ]);
        const { registry } = createPluginRegistryFixture(cfg);
        const record = createPluginRecord({ id: "openai" });
        registry.registry.plugins.push(record);
        const api = registry.createApi(record, { config: cfg, registrationMode: "discovery" });
        const captured = createCapturedPluginRegistration({
          id: record.id,
          config: cfg,
          registrationMode: "discovery",
        });
        // Native discovery supplies auth and factories; the real scoped registry owns auth lookup.
        plugin.register({
          ...captured.api,
          registerProvider: api.registerProvider,
          registerMediaUnderstandingProvider: api.registerMediaUnderstandingProvider,
        });
        const realAuth = await vi.importActual<
          typeof import("openclaw/plugin-sdk/provider-auth-runtime")
        >("openclaw/plugin-sdk/provider-auth-runtime");
        const store: AuthProfileStore = {
          version: 1,
          profiles: {
            "openai:siwc": {
              type: "oauth",
              provider: "openai",
              authFlow: "chatgpt-token-sharing",
              access: "siwc-token",
              refresh: "siwc-refresh",
              expires: Date.now() + 3_600_000,
            },
          },
        };
        authMocks.resolve.mockImplementation((params) =>
          realAuth.resolveApiKeyForProvider({ ...params, store }),
        );
        try {
          await withPluginRuntimeRegistryScope(registry.registry, async () => {
            const provider = registry.registry.mediaUnderstandingProviders.find(
              (entry) => entry.provider.id === "openai",
            )?.provider;
            if (!provider?.transcribeAudioWithContext) {
              throw new Error("OpenAI audio transcription registration missing");
            }
            if (apiKey === undefined) {
              expect(await provider.isAudioConfigured!({ cfg })).toBe(false);
              authMocks.resolve.mockClear();
              const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "unexpected" });
              const result = await provider.transcribeAudioWithContext({ cfg, ...audio, fetchFn });
              expect(result.ok).toBe(false);
              expect(getRequest().url).toBeNull();
              authMocks.resolve.mockClear();
            }
            store.profiles["openai:fixture-subscription"] = {
              type: "token",
              provider: "openai",
              token,
            };
            expect(await provider.isAudioConfigured!({ cfg })).toBe(true);
            authMocks.resolve.mockClear();
            const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "subscription" });
            const result = await provider.transcribeAudioWithContext({ cfg, ...audio, fetchFn });
            expect(result.ok).toBe(true);
            expect(getRequest().url).toBe("https://api.openai.com/v1/audio/transcriptions");
            expect(new Headers(getRequest().init?.headers).get("authorization")).toBe(
              `Bearer ${token}`,
            );
            expect(authMocks.resolve).toHaveBeenCalledTimes(2);
          });
        } finally {
          registry.rollbackPluginGlobalSideEffects(record.id, record);
        }
      }),
  );

  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://chatgpt.com/backend-api/codex", "https://api.openai.com/v1/audio/transcriptions"],
    ["https://custom.example/v1", "https://custom.example/v1/audio/transcriptions"],
  ])(
    "keeps an authored API key ahead of OAuth with provider base %s",
    async (baseUrl, expectedUrl) => {
      useAuth("fixture-platform-key", "api-key", "models.json");
      const cfg = makeConfig("fixture-platform-key", baseUrl, ["openai:chatgpt", "openai:audio"]);
      const original = structuredClone(cfg);
      expect(await isConfigured({ cfg, baseUrl })).toBe(true);
      authMocks.resolve.mockClear();
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });
      await transcribeWithContext({
        cfg,
        baseUrl,
        model: "gpt-4o-mini-transcribe",
        prompt: "Names: Ada",
        fetchFn,
      });
      expect(cfg).toEqual(original);
      expect(authMocks.resolve).toHaveBeenCalledTimes(1);
      expect(authMocks.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          modelApi: "openai-audio-transcriptions",
          cfg: expect.objectContaining({
            models: { providers: { openai: { ...cfg.models.providers.openai, auth: "api-key" } } },
          }),
        }),
      );
      const { url, init } = getRequest();
      expect(url).toBe(expectedUrl);
      expectForm(init, { model: "gpt-4o-mini-transcribe", prompt: "Names: Ada" });
    },
  );

  it.each([
    { baseUrl: "https://custom.example/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" },
    { baseUrl: "https://api.openai.com/v1?alternate=true" },
    { headers: { authorization: "Bearer other" } },
  ])("rejects unsupported subscription request settings before upload: %j", async (settings) => {
    useAuth(token, "oauth");
    const context = { cfg: {}, profile: "openai:audio", ...settings };
    expect(await isConfigured(context)).toBe(false);
    await expect(transcribeWithContext(context)).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/API-key profile/) }),
    });
  });

  it("does not switch billing routes after an authored credential failure", async () => {
    const failure = new Error("selected profile could not refresh");
    authMocks.resolve.mockRejectedValue(failure);
    await expect(transcribeWithContext()).resolves.toEqual({ ok: false, error: failure });
    expect(authMocks.resolve).toHaveBeenCalledTimes(1);
  });

  it("resolves credentials again after readiness and rejects before upload if they are lost", async () => {
    authMocks.resolve
      .mockResolvedValueOnce({
        apiKey: "fixture-platform-key",
        mode: "api-key",
        source: "profile:openai:audio",
      })
      .mockRejectedValueOnce(new Error("selected credentials removed"));
    const context = { cfg: {}, profile: "openai:audio" };
    expect(await isConfigured(context)).toBe(true);
    const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "unexpected" });
    expect(await transcribeWithContext({ ...context, fetchFn })).toMatchObject({
      ok: false,
      error: { message: "selected credentials removed" },
    });
    expect(getRequest().url).toBeNull();
  });

  it.each([400, 200])(
    "redacts reflected request credentials from HTTP %s diagnostics",
    async (status) => {
      const credential = "synthetic-only";
      authMocks.resolve.mockResolvedValue({
        apiKey: credential,
        mode: "oauth",
        profileId: "openai:fixture",
        source: "profile:openai:fixture",
      });
      const fetchFn = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
        return new Response(
          status === 400
            ? JSON.stringify({ error: { message: `Rejected ${credential}`, code: credential } })
            : credential,
          { status, headers: { "x-request-id": credential } },
        );
      });
      const error = await transcribeWithContext({ fetchFn }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message:
          status === 400
            ? "Audio transcription failed (HTTP 400): Rejected *** [code=***] [request_id=***]"
            : "Audio transcription failed: malformed JSON response",
      });
      expect(inspect(error)).not.toContain(credential);
      expect(authMocks.resolve).toHaveBeenCalledTimes(1);
    },
  );
});

describe("transcribeOpenAiAudio", () => {
  it.each([undefined, "Bearer override"])(
    "builds the request with authorization override %s",
    async (authorization) => {
      const { fetchFn, getRequest } = createRequestCaptureJsonFetch({ text: "hello" });
      const result = await transcribe({
        baseUrl: "https://api.example.com/v1/",
        model: " ",
        language: " en ",
        prompt: " hello ",
        mime: "audio/wav",
        headers: { "X-Custom": "1", ...(authorization ? { authorization } : {}) },
        fetchFn,
      });
      const { url: seenUrl, init: seenInit } = getRequest();
      expect(result).toEqual({ model: "gpt-4o-transcribe", text: "hello" });
      expect(seenUrl).toBe("https://api.example.com/v1/audio/transcriptions");
      expect(seenInit?.method).toBe("POST");
      expect(seenInit?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(seenInit?.headers);
      expect(headers.get("authorization")).toBe(authorization ?? "Bearer test-key");
      expect(headers.get("x-custom")).toBe("1");
      const form = seenInit?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expectForm(seenInit, { model: "gpt-4o-transcribe", language: "en", prompt: "hello" });
      expect(form.get("file")).toMatchObject({ type: "audio/wav", name: "voice.wav" });
    },
  );

  it.each([{}, { text: " " }])(
    "handles missing versus silent transcripts: %j",
    async (response) => {
      const { fetchFn } = createRequestCaptureJsonFetch(response);
      const result = transcribe({ fetchFn });
      if ("text" in response) {
        await expect(result).resolves.toEqual({ text: "", model: "gpt-4o-transcribe" });
      } else {
        await expect(result).rejects.toThrow("Audio transcription response missing text");
      }
    },
  );
});
