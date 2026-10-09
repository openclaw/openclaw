import { writeFileSync } from "node:fs";
import {
  createDebugProxyCaptureReaderAsync,
  finalizeDebugProxyCaptureAsync,
  initializeDebugProxyCaptureAsync,
} from "openclaw/plugin-sdk/proxy-capture";
import type { SpeechListVoicesRequest } from "openclaw/plugin-sdk/speech";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDebugProxyTestResetHooks } from "../test-support/debug-proxy-env-test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      fetchWithSsrFGuardMock(...args);
      return actual.fetchWithSsrFGuard(...args);
    },
  };
});

import { buildMicrosoftSpeechProvider } from "./speech-provider.js";
import * as ttsModule from "./tts.js";

async function listVoicesThroughProvider(req: SpeechListVoicesRequest = { providerConfig: {} }) {
  const listVoices = buildMicrosoftSpeechProvider().listVoices;
  if (!listVoices) {
    throw new Error("expected Microsoft voice listing support");
  }
  return await listVoices(req);
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
    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("throws on Microsoft voice list failures", async () => {
    mockVoiceResponse("nope", 503);
    await expect(listVoicesThroughProvider()).rejects.toThrow("Microsoft voices API error (503)");
  });

  it("prefers the configured provider request timeout", async () => {
    mockVoiceResponse([]);
    await listVoicesThroughProvider({ providerConfig: { timeoutMs: 2_345 }, timeoutMs: 1_234 });

    expect(fetchWithSsrFGuardMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: 2_345 }),
    );
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
    expect(
      events.some((event) => event.kind === "request" && event.host === "speech.platform.bing.com"),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.kind === "response" && event.host === "speech.platform.bing.com",
      ),
    ).toBe(true);
  });

  it("does not double-capture voice discovery when the global fetch patch is installed", async () => {
    proxyReset.captureProxyEnv();
    process.env.OPENCLAW_DEBUG_PROXY_ENABLED = "1";
    process.env.OPENCLAW_DEBUG_PROXY_SESSION_ID = "ms-voices-global-session";
    mockVoiceResponse([{ ShortName: "en-US-AvaNeural" }]);

    await initializeDebugProxyCaptureAsync("test");

    try {
      await listVoicesThroughProvider();
      await finalizeDebugProxyCaptureAsync();
      const reader = createDebugProxyCaptureReaderAsync({ env: process.env });
      const events = (await reader.getSessionEvents("ms-voices-global-session", 10)).filter(
        (event) => event.host === "speech.platform.bing.com",
      );
      expect(events).toHaveLength(2);
      const kinds = events.map((event) => String(event.kind)).toSorted();
      expect(kinds).toEqual(["request", "response"]);
    } finally {
      globalThis.fetch = proxyReset.originalFetch;
      await finalizeDebugProxyCaptureAsync();
    }
  });
});

describe("buildMicrosoftSpeechProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["en-US-MichelleNeural", "zh-CN-XiaoxiaoNeural", "zh-CN"],
    ["en-US-AvaNeural", "en-US-AvaNeural", "en-US"],
  ])("maps CJK input voice %s to %s (%s)", async (voice, expectedVoice, expectedLang) => {
    const edgeSpy = vi.spyOn(ttsModule, "edgeTTS").mockImplementation(async ({ outputPath }) => {
      writeFileSync(outputPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    });

    await buildMicrosoftSpeechProvider().synthesize({
      text: "你好，这是一个测试 hello",
      cfg: {},
      providerConfig: {
        enabled: true,
        voice,
        lang: "en-US",
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        saveSubtitles: false,
      },
      providerOverrides: {},
      timeoutMs: 1000,
      target: "audio-file",
    });

    expect(edgeSpy).toHaveBeenCalledExactlyOnceWith({
      text: "你好，这是一个测试 hello",
      outputPath: expect.stringMatching(/[/\\]speech\.mp3$/),
      timeoutMs: 1000,
      config: {
        enabled: true,
        voice: expectedVoice,
        lang: expectedLang,
        outputFormat: "audio-24khz-48kbitrate-mono-mp3",
        outputFormatConfigured: true,
        pitch: undefined,
        rate: undefined,
        volume: undefined,
        saveSubtitles: false,
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
