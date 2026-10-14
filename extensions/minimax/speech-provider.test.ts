// Minimax tests cover speech provider plugin behavior.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcodeAudioBufferToOpusMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcodeAudioBufferToOpusMock,
}));

import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";

function clearMinimaxAuthEnv() {
  vi.stubEnv("MINIMAX_API_KEY", undefined);
  vi.stubEnv("MINIMAX_OAUTH_TOKEN", undefined);
  vi.stubEnv("MINIMAX_CODE_PLAN_KEY", undefined);
  vi.stubEnv("MINIMAX_CODING_API_KEY", undefined);
}

function minimaxPortalStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "minimax-portal:test": {
        type: "token",
        provider: "minimax-portal",
        token: "portal-token",
      },
    },
  };
}

function seedMinimaxPortalProfile(agentDir: string) {
  saveAuthProfileStore(minimaxPortalStore(), agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

describe("buildMinimaxSpeechProvider", () => {
  const provider = buildMinimaxSpeechProvider({
    isProviderAuthProfileConfigured,
    isProviderAuthProfileConfiguredAsync,
  });

  function resolveProviderConfig(
    params: Parameters<NonNullable<typeof provider.resolveConfig>>[0],
  ): ReturnType<NonNullable<typeof provider.resolveConfig>> {
    const resolveConfig = provider.resolveConfig;
    if (!resolveConfig) {
      throw new Error("MiniMax speech provider did not expose config resolution");
    }
    return resolveConfig(params);
  }

  function parseDirectiveToken(
    params: Parameters<NonNullable<typeof provider.parseDirectiveToken>>[0],
  ): ReturnType<NonNullable<typeof provider.parseDirectiveToken>> {
    const parseToken = provider.parseDirectiveToken;
    if (!parseToken) {
      throw new Error("MiniMax speech provider did not expose directive parsing");
    }
    return parseToken(params);
  }

  describe("isConfigured", () => {
    let tempStateDir: string;
    let tempAgentDir: string;

    beforeEach(async () => {
      tempStateDir = await mkdtemp(path.join(tmpdir(), "openclaw-minimax-tts-auth-"));
      tempAgentDir = path.join(tempStateDir, "agents", "main", "agent");
      await mkdir(tempAgentDir, { recursive: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
      vi.stubEnv("OPENCLAW_AGENT_DIR", tempAgentDir);
      clearMinimaxAuthEnv();
      clearRuntimeAuthProfileStoreSnapshots();
    });

    afterEach(async () => {
      clearRuntimeAuthProfileStoreSnapshots();
      vi.unstubAllEnvs();
      await rm(tempStateDir, { recursive: true, force: true });
    });

    it("returns false when no apiKey anywhere", async () => {
      expect(await provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 30000 })).toBe(
        false,
      );
    });

    it("returns true when a MiniMax portal auth profile is available", async () => {
      seedMinimaxPortalProfile(tempAgentDir);

      expect(await provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 30000 })).toBe(
        true,
      );
    });
  });

  describe("resolveConfig", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("reads from providers.minimax in rawConfig", () => {
      const config = resolveProviderConfig({
        rawConfig: {
          providers: {
            minimax: {
              baseUrl: "https://custom.api.com",
              model: "speech-01-turbo",
              voiceId: "Chinese (Mandarin)_Warm_Girl",
              speed: 1.5,
              vol: 2,
              pitch: 3,
            },
          },
        },
        cfg: {} as never,
        timeoutMs: 30000,
      });
      expect(config.baseUrl).toBe("https://custom.api.com");
      expect(config.model).toBe("speech-01-turbo");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Warm_Girl");
      expect(config.speed).toBe(1.5);
      expect(config.vol).toBe(2);
      expect(config.pitch).toBe(3);
    });

    it("keeps trusted MINIMAX_API_HOST fallback for TTS baseUrl", () => {
      vi.stubEnv("MINIMAX_API_HOST", "https://api.minimax.io/anthropic");
      vi.stubEnv("MINIMAX_TTS_MODEL", "speech-01-turbo");
      vi.stubEnv("MINIMAX_TTS_VOICE_ID", "Chinese (Mandarin)_Gentle_Boy");
      const config = resolveProviderConfig({ rawConfig: {}, cfg: {} as never, timeoutMs: 30000 });
      expect(config.baseUrl).toBe("https://api.minimax.io");
      expect(config.model).toBe("speech-01-turbo");
      expect(config.voiceId).toBe("Chinese (Mandarin)_Gentle_Boy");
    });
  });

  describe("parseDirectiveToken", () => {
    const policy = {
      enabled: true,
      allowText: true,
      allowProvider: true,
      allowVoice: true,
      allowModelId: true,
      allowVoiceSettings: true,
      allowNormalization: true,
      allowSeed: true,
    };

    it.each([
      ["voice", "Chinese (Mandarin)_Warm_Girl", { voiceId: "Chinese (Mandarin)_Warm_Girl" }],
      ["model", "speech-01-turbo", { model: "speech-01-turbo" }],
      ["speed", "1.5", { speed: 1.5 }],
      ["vol", "10", { vol: 10 }],
      ["pitch", "-3", { pitch: -3 }],
    ])("parses %s=%s", (key, value, overrides) => {
      const result = parseDirectiveToken({ key, value, policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toBeUndefined();
      expect(result.overrides).toEqual(overrides);
    });

    it.each([{ name: "warns on invalid speed", key: "speed", value: "5.0" }])(
      "$name",
      ({ key, value }) => {
        const result = parseDirectiveToken({ key, value, policy });
        expect(result.handled).toBe(true);
        expect(result.warnings).toHaveLength(1);
        expect(result.overrides).toBeUndefined();
      },
    );

    it.each(["0"])("describes the MiniMax volume boundary for vol=%s", (value) => {
      const result = parseDirectiveToken({ key: "vol", value, policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toEqual([
        `invalid MiniMax volume "${value}" (must be greater than 0 and at most 10)`,
      ]);
      expect(result.overrides).toBeUndefined();
    });

    it("warns on out-of-range pitch", () => {
      const result = parseDirectiveToken({ key: "pitch", value: "20", policy });
      expect(result.handled).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    it("returns handled=false for unknown keys", () => {
      const result = parseDirectiveToken({
        key: "unknown_key",
        value: "whatever",
        policy,
      });
      expect(result.handled).toBe(false);
    });

    it.each([
      {
        name: "suppresses voice when policy disallows it",
        key: "voice",
        policy: { ...policy, allowVoice: false },
      },
      {
        name: "suppresses model when policy disallows it",
        key: "model",
        policy: { ...policy, allowModelId: false },
      },
    ])("$name", ({ key, policy: overridePolicy }) => {
      const result = parseDirectiveToken({ key, value: "test", policy: overridePolicy });
      expect(result.handled).toBe(true);
      expect(result.overrides).toBeUndefined();
    });
  });

  describe("synthesize", () => {
    function synthesize(overrides: Partial<Parameters<typeof provider.synthesize>[0]> = {}) {
      return provider.synthesize({
        text: "Test",
        cfg: {},
        providerConfig: { apiKey: "sk-test" },
        target: "audio-file",
        timeoutMs: 30000,
        ...overrides,
      });
    }

    function mockAudioResponse(audio = "audio") {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        Response.json({ data: { audio: Buffer.from(audio).toString("hex") } }),
      );
    }
    const savedFetch = globalThis.fetch;
    let tempStateDir: string;
    let tempAgentDir: string;

    beforeEach(async () => {
      tempStateDir = await mkdtemp(path.join(tmpdir(), "openclaw-minimax-tts-synth-"));
      tempAgentDir = path.join(tempStateDir, "agents", "main", "agent");
      await mkdir(tempAgentDir, { recursive: true });
      vi.stubEnv("OPENCLAW_AGENT_DIR", tempAgentDir);
      vi.stubEnv("OPENCLAW_STATE_DIR", tempStateDir);
      clearMinimaxAuthEnv();
      clearRuntimeAuthProfileStoreSnapshots();
      vi.stubGlobal("fetch", vi.fn());
      transcodeAudioBufferToOpusMock.mockReset();
    });

    afterEach(async () => {
      globalThis.fetch = savedFetch;
      vi.unstubAllEnvs();
      clearRuntimeAuthProfileStoreSnapshots();
      vi.restoreAllMocks();
      await rm(tempStateDir, { recursive: true, force: true });
    });

    function firstFetchCall(): unknown[] {
      const call = vi.mocked(globalThis.fetch).mock.calls[0];
      if (!call) {
        throw new Error("Expected MiniMax TTS fetch call");
      }
      return call as unknown[];
    }

    function firstFetchInit(): RequestInit | undefined {
      return firstFetchCall()[1] as RequestInit | undefined;
    }

    function firstFetchBody(): Record<string, unknown> {
      const init = firstFetchInit();
      if (typeof init?.body !== "string") {
        throw new Error("Expected MiniMax TTS fetch init body");
      }
      return JSON.parse(init.body) as Record<string, unknown>;
    }

    it("transcodes MiniMax MP3 to Opus for voice-note targets", async () => {
      mockAudioResponse("fake-mp3-data");
      transcodeAudioBufferToOpusMock.mockResolvedValueOnce(Buffer.from("fake-opus-data"));

      const result = await synthesize({
        text: "Hello world",
        providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
        target: "voice-note",
      });

      expect(result.outputFormat).toBe("opus");
      expect(result.fileExtension).toBe(".opus");
      expect(result.voiceCompatible).toBe(true);
      expect(result.audioBuffer.toString()).toBe("fake-opus-data");
      expect(transcodeAudioBufferToOpusMock).toHaveBeenCalledWith({
        audioBuffer: Buffer.from("fake-mp3-data"),
        inputExtension: "mp3",
        tempPrefix: "tts-minimax-",
        timeoutMs: 30000,
      });
    });

    it("applies overrides", async () => {
      mockAudioResponse();

      await synthesize({
        providerOverrides: {
          model: "speech-01-turbo",
          voiceId: "custom_voice",
          speed: 1.5,
          vol: 1.5,
          pitch: 0.5,
        },
      });

      const body = firstFetchBody();
      expect(body.model).toBe("speech-01-turbo");
      const voiceSetting = body.voice_setting as Record<string, unknown>;
      expect(voiceSetting.voice_id).toBe("custom_voice");
      expect(voiceSetting.speed).toBe(1.5);
      expect(voiceSetting.vol).toBe(1.5);
      expect(voiceSetting.pitch).toBe(0);
    });

    it("drops malformed voice settings before synthesis", async () => {
      mockAudioResponse();

      await synthesize({
        providerConfig: {
          apiKey: "sk-test",
          speed: 3,
          vol: -1,
          pitch: 20,
        },
      });

      const voiceSetting = firstFetchBody().voice_setting as Record<string, unknown>;
      expect(voiceSetting.speed).toBe(1);
      expect(voiceSetting.vol).toBe(1);
      expect(voiceSetting.pitch).toBe(0);
    });

    it("uses a MiniMax Token Plan env var when no API key is configured", async () => {
      process.env.MINIMAX_CODING_API_KEY = "sk-cp-env";
      mockAudioResponse();

      await synthesize({ text: "Token plan TTS", providerConfig: {} });

      const init = firstFetchInit();
      expect(init?.headers).toEqual({
        Authorization: "Bearer sk-cp-env",
        "Content-Type": "application/json",
      });
    });

    it("uses a minimax-portal auth profile before env API keys", async () => {
      process.env.MINIMAX_API_KEY = "sk-env";
      seedMinimaxPortalProfile(tempAgentDir);
      mockAudioResponse();

      await synthesize({
        text: "Portal TTS",
        cfg: {
          models: {
            providers: {
              "minimax-portal": { baseUrl: "https://api.minimaxi.com/anthropic" },
            },
          },
        } as never,
        providerConfig: {},
      });

      const url = firstFetchCall()[0];
      const init = firstFetchInit();
      expect(url).toBe("https://api.minimaxi.com/v1/t2a_v2");
      expect(init?.headers).toEqual({
        Authorization: "Bearer portal-token",
        "Content-Type": "application/json",
      });
    });

    it("does not send a request for a blank environment API key", async () => {
      process.env.MINIMAX_API_KEY = "   ";

      await expect(synthesize({ providerConfig: {} })).rejects.toThrow("MiniMax TTS auth missing");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("throws on API error with response body", async () => {
      vi.mocked(globalThis.fetch).mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      );
      await expect(synthesize()).rejects.toThrow("MiniMax TTS API error (401): Unauthorized");
    });
  });

  describe("listVoices", () => {
    it("returns known voices", async () => {
      const listVoices = provider.listVoices;
      if (!listVoices) {
        throw new Error("Expected MiniMax provider listVoices");
      }
      const voices = await listVoices({} as never);
      expect(voices).toStrictEqual(
        [
          "English_expressive_narrator",
          "Chinese (Mandarin)_Warm_Girl",
          "Chinese (Mandarin)_Lively_Girl",
          "Chinese (Mandarin)_Gentle_Boy",
          "Chinese (Mandarin)_Steady_Boy",
        ].map((id) => ({ id, name: id })),
      );
    });
  });
});
