import { writeFileSync } from "node:fs";
import { EdgeTTS } from "node-edge-tts";
import {
  createDebugProxyCaptureReaderAsync,
  finalizeDebugProxyCaptureAsync,
} from "openclaw/plugin-sdk/proxy-capture";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { isTtsProviderConfigured, resolveTtsConfig } from "openclaw/plugin-sdk/tts-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";
import { buildMicrosoftSpeechProvider } from "./speech-provider.js";

const provider = buildMicrosoftSpeechProvider();

async function listVoicesThroughProvider(body: unknown, status = 200) {
  globalThis.fetch = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(JSON.stringify(body), { status }));
  return await provider.listVoices?.({ providerConfig: {} });
}

describe("listMicrosoftVoices", () => {
  beforeEach(async () => {
    const state = await createOpenClawTestState({ layout: "state-only" });
    // Returned cleanup runs after the proxy's afterEach teardown.
    return () => state.cleanup();
  });
  const proxyReset = installDebugProxyTestResetHooks();

  it("returns an empty catalog for a malformed top-level payload", async () => {
    await expect(listVoicesThroughProvider(null)).resolves.toEqual([]);
  });

  it("skips malformed rows without discarding valid voices", async () => {
    const fetchSpy = vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard");
    const voices = await listVoicesThroughProvider([
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

    expect(voices).toEqual([
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
    expect(fetchSpy).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
  });

  it("throws on Microsoft voice list failures", async () => {
    await expect(listVoicesThroughProvider("nope", 503)).rejects.toThrow(
      "Microsoft voices API error (503)",
    );
  });

  it("records voice discovery exchanges in debug proxy capture mode", async () => {
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-session";
    await listVoicesThroughProvider([{ ShortName: "en-US-AvaNeural" }]);
    await finalizeDebugProxyCaptureAsync();
    const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
    const events = await reader.getSessionEvents("ms-voices-session", 10);
    for (const kind of ["request", "response"]) {
      expect(events).toContainEqual(
        expect.objectContaining({ kind, host: "speech.platform.bing.com" }),
      );
    }
  });
});

it("supports the public synchronous TTS readiness API through the compatibility window", () => {
  const cfg = { tts: { providers: { microsoft: { enabled: true } } } };

  expect(isTtsProviderConfigured(resolveTtsConfig(cfg), provider, cfg)).toBe(true);
});

it("maps the default voice to Chinese for CJK input", async () => {
  const state = await createOpenClawTestState({ layout: "state-only" });
  onTestFinished(() => state.cleanup());
  const edgeSpy = vi.spyOn(EdgeTTS.prototype, "ttsPromise").mockImplementation(async function (
    this: EdgeTTS,
    _text,
    outputPath,
  ) {
    expect(this).toMatchObject({
      voice: "zh-CN-XiaoxiaoNeural",
      lang: "zh-CN",
      outputFormat: "audio-24khz-48kbitrate-mono-mp3",
      saveSubtitles: false,
      timeout: 1000,
    });
    writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  });
  onTestFinished(() => edgeSpy.mockRestore());

  const text = "你好，这是一个测试 hello";
  await provider.synthesize({
    text,
    cfg: {},
    providerConfig: { outputFormatConfigured: true },
    providerOverrides: {},
    timeoutMs: 1000,
    target: "audio-file",
  });

  expect(edgeSpy).toHaveBeenCalledExactlyOnceWith(
    text,
    expect.stringMatching(/speech[.]mp3.*[.]part$/),
  );
});

it("preserves inherited Microsoft Talk settings and filters blank request overrides", () => {
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
