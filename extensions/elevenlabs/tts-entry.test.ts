import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTtsCommands } from "../../src/auto-reply/reply/commands-tts.js";
import { buildCommandTestParams } from "../../src/auto-reply/reply/commands.test-harness.js";
import type { ChannelTtsVoiceDeliveryCapabilities } from "../../src/channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../src/config/types.js";
import { OpenClawSchema } from "../../src/config/zod-schema.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../src/test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../src/test-utils/openclaw-test-state.js";
import { buildElevenLabsSpeechProvider } from "./speech-provider-factory.js";

const CHANNEL = "whatsapp";
const VOICE = "pMsXgVXv3BLzUgSXRplE";
const LOCATORS = [
  { pronunciationDictionaryId: "dictionary-fixture", versionId: "version-fixture" },
];
const AUDIO_FILE_DELIVERY: ChannelTtsVoiceDeliveryCapabilities = {
  synthesisTarget: "audio-file",
  audioFileFormats: ["mp3", "caf", "audio/mpeg", "audio/x-caf"],
  preferAudioFileFormat: "caf",
};

let state: OpenClawTestState;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function buildConfig(ttsOverrides: Record<string, unknown> = {}): OpenClawConfig {
  return {
    commands: { text: true },
    channels: { [CHANNEL]: { allowFrom: ["*"] } },
    session: { mainKey: "main", scope: "per-sender" },
    tts: {
      auto: "always",
      provider: "elevenlabs",
      providers: {
        elevenlabs: {
          apiKey: "test-key",
          voiceId: VOICE,
          modelId: "eleven_multilingual_v2",
          pronunciationDictionaryLocators: LOCATORS,
        },
      },
      ...ttsOverrides,
    },
  } as OpenClawConfig;
}

function installProviders(): void {
  const registry = createTestRegistry([
    {
      pluginId: CHANNEL,
      source: "elevenlabs-tts-entry-test",
      plugin: createChannelTestPluginBase({
        id: CHANNEL,
        capabilities: {
          chatTypes: ["direct"],
          media: true,
          tts: {
            voice: AUDIO_FILE_DELIVERY,
          },
        },
      }),
    },
  ]);
  registry.speechProviders.push({
    pluginId: "elevenlabs",
    source: "elevenlabs-tts-entry-test",
    provider: buildElevenLabsSpeechProvider({ formatErrorMessage }),
  });
  setActivePluginRegistry(registry);
}

async function runAudioCommand(cfg: OpenClawConfig): Promise<void> {
  const params = buildCommandTestParams(
    "/tts audio OpenClaw pronunciation check",
    cfg,
    { Provider: CHANNEL, Surface: CHANNEL },
    { workspaceDir: state.workspaceDir },
  );
  params.command.isAuthorizedSender = true;

  const result = await handleTtsCommands(params, true);
  expect(result?.shouldContinue).toBe(false);
  expect(result?.reply?.mediaUrl).toEqual(expect.any(String));
  expect(fetchMock).toHaveBeenCalledOnce();
}

async function readLastRequestBody(): Promise<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls.at(-1) ?? [];
  if (typeof init?.body !== "string") {
    throw new Error("Expected ElevenLabs TTS request body to be JSON text");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("ElevenLabs pronunciation dictionaries through /tts audio", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({
      layout: "home",
      prefix: "openclaw-elevenlabs-tts-entry-",
    });
    vi.stubEnv("OPENCLAW_TTS_PREFS", state.path("tts-prefs.json"));
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(Buffer.from([0x49, 0x44, 0x33]), {
        headers: { "content-type": "audio/mpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    installProviders();
  });

  afterEach(async () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await state.cleanup();
  });

  it("sends configured locators through the ordinary audio command", async () => {
    await runAudioCommand(buildConfig());

    expect(await readLastRequestBody()).toMatchObject({
      text: "OpenClaw pronunciation check",
      pronunciation_dictionary_locators: [
        {
          pronunciation_dictionary_id: LOCATORS[0]?.pronunciationDictionaryId,
          version_id: LOCATORS[0]?.versionId,
        },
      ],
    });
  });

  it("keeps the option optional for fresh installs and preserves it on stable configs", () => {
    const freshInstall = OpenClawSchema.parse({});
    expect(freshInstall.tts).toBeUndefined();

    const stableUpgrade = OpenClawSchema.parse({
      update: { channel: "stable" },
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            apiKey: "test-key",
            pronunciationDictionaryLocators: LOCATORS,
          },
        },
      },
    });
    expect(stableUpgrade.tts?.providers?.elevenlabs?.pronunciationDictionaryLocators).toEqual(
      LOCATORS,
    );
  });

  it.each([
    {
      name: "agent scope",
      overrides: {},
      agents: {
        list: [
          {
            id: "main",
            tts: {
              providers: { elevenlabs: { pronunciationDictionaryLocators: [] } },
            },
          },
        ],
      },
    },
    {
      name: "persona",
      overrides: {
        persona: "without-dictionaries",
        personas: {
          "without-dictionaries": {
            providers: { elevenlabs: { pronunciationDictionaryLocators: [] } },
          },
        },
      },
      agents: undefined,
    },
  ])("allows $name configuration to clear inherited locators", async ({ overrides, agents }) => {
    const cfg = {
      ...buildConfig(overrides),
      ...(agents ? { agents } : {}),
    } as OpenClawConfig;

    await runAudioCommand(cfg);

    expect(await readLastRequestBody()).not.toHaveProperty("pronunciation_dictionary_locators");
  });
});
