import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { synthesizeSpeech } from "openclaw/plugin-sdk/tts-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const AUDIO = Buffer.from([0x49, 0x44, 0x33]);
const TEXT = "OpenClaw pronunciation check";
const VOICE = "pMsXgVXv3BLzUgSXRplE";
const LOCATORS = [
  { pronunciationDictionaryId: "dictionary-fixture", versionId: "version-fixture" },
];

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: async (params: { url: string; init?: RequestInit }) => {
    fetchWithSsrFGuardMock(params);
    return {
      response: await globalThis.fetch(params.url, params.init),
      release: async () => {},
    };
  },
  ssrfPolicyFromHttpBaseUrlAllowedHostname: () => undefined,
}));

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const originalFetch = globalThis.fetch;

function buildConfig(
  options: {
    includeLocators?: boolean;
    agentClearsLocators?: boolean;
    personaClearsLocators?: boolean;
  } = {},
): OpenClawConfig {
  const providerConfig = {
    apiKey: "test-key",
    voiceId: VOICE,
    modelId: "eleven_multilingual_v2",
    ...(options.includeLocators === false ? {} : { pronunciationDictionaryLocators: LOCATORS }),
  };
  return {
    tts: {
      auto: "always",
      provider: "elevenlabs",
      providers: { elevenlabs: providerConfig },
      ...(options.personaClearsLocators
        ? {
            persona: "without-dictionaries",
            personas: {
              "without-dictionaries": {
                providers: {
                  elevenlabs: { pronunciationDictionaryLocators: [] },
                },
              },
            },
          }
        : {}),
    },
    ...(options.agentClearsLocators
      ? {
          agents: {
            list: [
              {
                id: "main",
                tts: {
                  providers: {
                    elevenlabs: { pronunciationDictionaryLocators: [] },
                  },
                },
              },
            ],
          },
        }
      : {}),
  } as OpenClawConfig;
}

function installProvider(): void {
  const registry = createEmptyPluginRegistry();
  registry.speechProviders.push({
    pluginId: "elevenlabs",
    source: "elevenlabs-speech-runtime-contract-test",
    provider: buildElevenLabsSpeechProvider({ formatErrorMessage }),
  });
  setActivePluginRegistry(registry);
}

function requestBody(): Record<string, unknown> {
  expect(fetchMock).toHaveBeenCalledOnce();
  const [, init] = fetchMock.mock.calls[0] ?? [];
  if (typeof init?.body !== "string") {
    throw new Error("Expected ElevenLabs TTS request body to be JSON text");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function requestUrl(): URL {
  const [input] = fetchMock.mock.calls[0] ?? [];
  if (!input) {
    throw new Error("Expected an ElevenLabs TTS request");
  }
  if (typeof input === "string") {
    return new URL(input);
  }
  return input instanceof URL ? input : new URL(input.url);
}

async function withFixture(run: (prefsPath: string) => Promise<void>): Promise<void> {
  await withTempHome(async (home) => {
    await run(path.join(home, "tts-prefs.json"));
  });
}

async function synthesize(cfg: OpenClawConfig, prefsPath: string, agentId?: string): Promise<void> {
  const result = await synthesizeSpeech({
    text: TEXT,
    cfg,
    prefsPath,
    disableFallback: true,
    ...(agentId ? { agentId } : {}),
  });
  expect(result).toMatchObject({
    success: true,
    provider: "elevenlabs",
    audioBuffer: AUDIO,
  });
}

describe("ElevenLabs pronunciation dictionaries through the public TTS runtime", () => {
  beforeEach(() => {
    fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock;
    installProvider();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setActivePluginRegistry(createEmptyPluginRegistry());
    fetchWithSsrFGuardMock.mockClear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends configured locators through ordinary TTS synthesis", async () => {
    await withFixture(async (prefsPath) => {
      await synthesize(buildConfig(), prefsPath);

      expect(requestBody()).toMatchObject({
        text: TEXT,
        pronunciation_dictionary_locators: [
          {
            pronunciation_dictionary_id: LOCATORS[0]?.pronunciationDictionaryId,
            version_id: LOCATORS[0]?.versionId,
          },
        ],
      });
    });
  });

  it("keeps existing stored TTS config working without dictionary locators", async () => {
    await withFixture(async (prefsPath) => {
      await synthesize(buildConfig({ includeLocators: false }), prefsPath);

      expect(requestBody()).toMatchObject({
        text: TEXT,
        model_id: "eleven_multilingual_v2",
      });
      expect(requestUrl().pathname).toBe(`/v1/text-to-speech/${VOICE}`);
      expect(requestBody()).not.toHaveProperty("pronunciation_dictionary_locators");
    });
  });

  it("allows agent scope configuration to clear inherited locators", async () => {
    await withFixture(async (prefsPath) => {
      await synthesize(buildConfig({ agentClearsLocators: true }), prefsPath, "main");

      expect(requestBody()).not.toHaveProperty("pronunciation_dictionary_locators");
    });
  });

  it("allows persona configuration to clear inherited locators", async () => {
    await withFixture(async (prefsPath) => {
      await synthesize(buildConfig({ personaClearsLocators: true }), prefsPath);

      expect(requestBody()).not.toHaveProperty("pronunciation_dictionary_locators");
    });
  });
});
