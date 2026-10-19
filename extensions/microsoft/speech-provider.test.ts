import { writeFileSync } from "node:fs";
import {
  createDebugProxyCaptureReaderAsync,
  finalizeDebugProxyCaptureAsync,
} from "openclaw/plugin-sdk/proxy-capture";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { isTtsProviderConfigured, resolveTtsConfig } from "openclaw/plugin-sdk/tts-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: vi.fn(actual.fetchWithSsrFGuard),
  };
});

import { buildMicrosoftSpeechProvider } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

async function listVoicesThroughProvider() {
  const listVoices = buildMicrosoftSpeechProvider().listVoices;
  if (!listVoices) {
    throw new Error("expected Microsoft voice listing support");
  }
  return await listVoices({ providerConfig: {} });
}

function mockVoiceResponse(body: unknown, status = 200) {
  globalThis.fetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("listMicrosoftVoices", () => {
  let openClawState: OpenClawTestState;

  beforeEach(async () => {
    openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "microsoft-voices-capture-",
    });
  });

  afterEach(async () => {
    await openClawState.cleanup();
  });

  // Install after local teardown so the proxy snapshot is restored before the
  // state helper removes its directory and restores the outer environment.
  const proxyReset = installDebugProxyTestResetHooks();

  it("returns an empty catalog for a malformed top-level payload", async () => {
    mockVoiceResponse(null);
    await expect(listVoicesThroughProvider()).resolves.toEqual([]);
  });

  it("skips malformed rows without discarding valid voices", async () => {
    mockVoiceResponse([
      null,
      "unexpected",
      [],
      { ShortName: 42 },
      {
        ShortName: "en-US-AvaNeural",
        FriendlyName: "Microsoft Ava Online (Natural) - English (United States)",
        Locale: "en-US",
        Gender: "Female",
        VoiceTag: {
          ContentCategories: [null, "General"],
          VoicePersonalities: [false, "Friendly", "Positive"],
        },
      },
    ]);

    await expect(listVoicesThroughProvider()).resolves.toEqual([
      {
        id: "en-US-AvaNeural",
        name: "Microsoft Ava Online (Natural) - English (United States)",
        category: "General",
        description: "Friendly, Positive",
        locale: "en-US",
        gender: "Female",
        personalities: ["Friendly", "Positive"],
      },
    ]);
    expect(fetchWithSsrFGuard).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("throws on Microsoft voice list failures", async () => {
    mockVoiceResponse("nope", 503);
    await expect(listVoicesThroughProvider()).rejects.toThrow("Microsoft voices API error (503)");
  });

  it("records voice discovery exchanges in debug proxy capture mode", async () => {
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-session";
    mockVoiceResponse([{ ShortName: "en-US-AvaNeural" }]);

    await listVoicesThroughProvider();
    await finalizeDebugProxyCaptureAsync();
    const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
    const events = await reader.getSessionEvents("ms-voices-session", 10);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "request", host: "speech.platform.bing.com" }),
        expect.objectContaining({ kind: "response", host: "speech.platform.bing.com" }),
      ]),
    );
  });
});

describe("buildMicrosoftSpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("supports the public synchronous TTS readiness API through the compatibility window", () => {
    const cfg = { tts: { providers: { microsoft: { enabled: true } } } };

    expect(
      isTtsProviderConfigured(resolveTtsConfig(cfg), buildMicrosoftSpeechProvider(), cfg),
    ).toBe(true);
  });

  it("maps the default voice to Chinese for CJK input", async () => {
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    const text = "你好，这是一个测试 hello";
    const providerConfig = {
      enabled: true,
      voice: "en-US-MichelleNeural",
      lang: "en-US",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      outputFormatConfigured: true,
      saveSubtitles: false,
    };
    await buildMicrosoftSpeechProvider().synthesize({
      text,
      cfg: {},
      providerConfig,
      providerOverrides: {},
      timeoutMs: 1000,
      target: "audio-file",
    });

    expect(edgeSpy).toHaveBeenCalledExactlyOnceWith({
      text,
      outputPath: expect.stringMatching(/[/\\]speech\.mp3$/),
      timeoutMs: 1000,
      config: {
        ...providerConfig,
        voice: "zh-CN-XiaoxiaoNeural",
        lang: "zh-CN",
        pitch: undefined,
        rate: undefined,
        volume: undefined,
        proxy: undefined,
        timeoutMs: undefined,
      },
    });
  });
});

it("preserves inherited Microsoft Talk settings and filters blank request overrides", () => {
  const provider = buildMicrosoftSpeechProvider();
  const params = { voiceId: " ", outputFormat: " ogg-24khz-16bit-mono-opus " };
  const talk = provider.resolveTalkConfig?.({
    cfg: {},
    baseTtsConfig: { providers: { microsoft: { voice: "base-voice", pitch: "+10Hz" } } },
    talkProviderConfig: { ...params, pitch: " ", rate: " +20% ", timeoutMs: 0 },
    timeoutMs: 1000,
  });
  expect(talk).toMatchObject({
    voice: "base-voice",
    pitch: "+10Hz",
    rate: "+20%",
    outputFormat: "ogg-24khz-16bit-mono-opus",
    timeoutMs: 0,
  });
  expect(provider.resolveTalkOverrides?.({ talkProviderConfig: {}, params })).toStrictEqual({
    outputFormat: "ogg-24khz-16bit-mono-opus",
  });
});
