import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  saveAuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechDirectivePolicy } from "../test-support/speech-directive-policy.test-support.js";

const transcode = vi.hoisted(() => vi.fn());

// mock-isolation: Capture speech transcoding without invoking ffmpeg.
vi.mock("openclaw/plugin-sdk/media-runtime", () => ({
  transcodeAudioBufferToOpus: transcode,
}));

import { buildMinimaxSpeechProvider } from "./speech-provider-factory.js";

function seedMinimaxPortalProfile(agentDir: string) {
  const credential = { type: "token" as const, provider: "minimax-portal", token: "portal-token" };
  saveAuthProfileStore({ version: 1, profiles: { "minimax-portal:test": credential } }, agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

const provider = buildMinimaxSpeechProvider({
  isProviderAuthProfileConfigured,
  isProviderAuthProfileConfiguredAsync,
});

const { resolveConfig, parseDirectiveToken } = provider;
if (!resolveConfig || !parseDirectiveToken) {
  throw new Error("MiniMax speech provider must expose config and directive hooks");
}
const resolveProviderConfig = (rawConfig: Record<string, unknown>) =>
  resolveConfig({ rawConfig, cfg: {}, timeoutMs: 30000 });

describe("resolveConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads from providers.minimax in rawConfig", () => {
    const minimax = {
      baseUrl: "https://custom.api.com",
      model: "speech-01-turbo",
      voiceId: "Chinese (Mandarin)_Warm_Girl",
      speed: 1.5,
      vol: 2,
      pitch: 3,
    };
    expect(resolveProviderConfig({ providers: { minimax } })).toMatchObject(minimax);
  });

  it("keeps trusted MINIMAX_API_HOST fallback for TTS baseUrl", () => {
    vi.stubEnv("MINIMAX_API_HOST", "https://api.minimax.io/anthropic");
    vi.stubEnv("MINIMAX_TTS_MODEL", "speech-01-turbo");
    vi.stubEnv("MINIMAX_TTS_VOICE_ID", "Chinese (Mandarin)_Gentle_Boy");
    expect(resolveProviderConfig({})).toMatchObject({
      baseUrl: "https://api.minimax.io",
      model: "speech-01-turbo",
      voiceId: "Chinese (Mandarin)_Gentle_Boy",
    });
  });
});

describe("parseDirectiveToken", () => {
  const policy = createSpeechDirectivePolicy();

  it.each([
    [
      "voice",
      "Chinese (Mandarin)_Warm_Girl",
      {},
      { handled: true, overrides: { voiceId: "Chinese (Mandarin)_Warm_Girl" } },
    ],
    ["model", "speech-01-turbo", {}, { handled: true, overrides: { model: "speech-01-turbo" } }],
    ["speed", "1.5", {}, { handled: true, overrides: { speed: 1.5 } }],
    ["vol", "10", {}, { handled: true, overrides: { vol: 10 } }],
    ["pitch", "-3", {}, { handled: true, overrides: { pitch: -3 } }],
    ["speed", "5.0", {}, { handled: true, warnings: [expect.any(String)] }],
    ["unknown_key", "whatever", {}, { handled: false }],
    ["voice", "test", { allowVoice: false }, { handled: true }],
    ["model", "test", { allowModelId: false }, { handled: true }],
  ] as const)("parses %s=%s under policy %j", (key, value, flags, expected) => {
    expect(parseDirectiveToken({ key, value, policy: { ...policy, ...flags } })).toEqual(expected);
  });
});

describe("MiniMax auth and synthesis", () => {
  let stateDir: string;
  let agentDir: string;
  const fetchMock = vi.fn<typeof fetch>();
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
    fetchMock.mockResolvedValueOnce(
      Response.json({ data: { audio: Buffer.from(audio).toString("hex") } }),
    );
  }
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), "openclaw-minimax-tts-"));
    agentDir = path.join(stateDir, "agents", "main", "agent");
    await mkdir(agentDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", agentDir);
    vi.stubEnv("MINIMAX_API_KEY", undefined);
    vi.stubEnv("MINIMAX_OAUTH_TOKEN", undefined);
    vi.stubEnv("MINIMAX_CODE_PLAN_KEY", undefined);
    vi.stubEnv("MINIMAX_CODING_API_KEY", undefined);
    clearRuntimeAuthProfileStoreSnapshots();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    transcode.mockReset();
  });

  afterEach(async () => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await rm(stateDir, { recursive: true, force: true });
  });

  it.each([false, true])(
    "reports configured=%s for portal profile availability",
    async (available) => {
      if (available) {
        seedMinimaxPortalProfile(agentDir);
      }
      await expect(
        provider.isConfiguredAsync?.({ providerConfig: {}, timeoutMs: 30000 }),
      ).resolves.toBe(available);
    },
  );

  const firstFetchInit = () => fetchMock.mock.calls[0]?.[1];

  function firstFetchBody(): unknown {
    const body = firstFetchInit()?.body;
    if (typeof body !== "string") {
      throw new Error("Expected MiniMax TTS fetch init body");
    }
    return JSON.parse(body);
  }

  it("transcodes MiniMax MP3 to Opus for voice-note targets", async () => {
    mockAudioResponse("fake-mp3-data");
    transcode.mockResolvedValueOnce(Buffer.from("fake-opus-data"));

    const result = await synthesize({
      text: "Hello world",
      providerConfig: { apiKey: "sk-test", baseUrl: "https://api.minimaxi.com" },
      target: "voice-note",
    });

    expect(result).toMatchObject({
      outputFormat: "opus",
      fileExtension: ".opus",
      voiceCompatible: true,
      audioBuffer: Buffer.from("fake-opus-data"),
    });
    expect(transcode).toHaveBeenCalledWith({
      audioBuffer: Buffer.from("fake-mp3-data"),
      inputExtension: "mp3",
      tempPrefix: "tts-minimax-",
      timeoutMs: 30000,
    });
  });

  it.each([
    [
      "providerOverrides",
      {
        model: "speech-01-turbo",
        voiceId: "custom_voice",
        speed: 1.5,
        vol: 1.5,
        pitch: 0.5,
      },
      {
        model: "speech-01-turbo",
        voice_setting: { voice_id: "custom_voice", speed: 1.5, vol: 1.5, pitch: 0 },
      },
    ],
    [
      "providerConfig",
      { apiKey: "sk-test", speed: 3, vol: -1, pitch: 20 },
      { voice_setting: { speed: 1, vol: 1, pitch: 0 } },
    ],
  ] as const)("normalizes %s synthesis settings", async (field, settings, expected) => {
    mockAudioResponse();
    await synthesize(
      field === "providerOverrides"
        ? { providerOverrides: settings }
        : { providerConfig: settings },
    );
    expect(firstFetchBody()).toMatchObject(expected);
  });

  it.each([false, true])("uses portal profile=%s ahead of environment fallback", async (portal) => {
    vi.stubEnv(
      portal ? "MINIMAX_API_KEY" : "MINIMAX_CODING_API_KEY",
      portal ? "sk-env" : "sk-cp-env",
    );
    if (portal) {
      seedMinimaxPortalProfile(agentDir);
    }
    mockAudioResponse();
    await synthesize({
      cfg: portal
        ? {
            models: {
              providers: {
                "minimax-portal": { baseUrl: "https://api.minimaxi.com/anthropic", models: [] },
              },
            },
          }
        : {},
      providerConfig: {},
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      portal ? "https://api.minimaxi.com/v1/t2a_v2" : "https://api.minimax.io/v1/t2a_v2",
    );
    expect(firstFetchInit()?.headers).toEqual({
      Authorization: portal ? "Bearer portal-token" : "Bearer sk-cp-env",
      "Content-Type": "application/json",
    });
  });

  it("does not send a request for a blank environment API key", async () => {
    process.env.MINIMAX_API_KEY = "   ";

    await expect(synthesize({ providerConfig: {} })).rejects.toThrow("MiniMax TTS auth missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
