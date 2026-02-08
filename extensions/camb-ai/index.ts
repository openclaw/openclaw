import type { OpenClawPluginApi } from "../../src/plugins/types.js";

// SpeechModel string literal type matching the SDK
type SpeechModel = "auto" | "mars-pro" | "mars-flash" | "mars-instruct";
import { registerCambAiCli } from "./src/cli.js";
import { CambClientWrapper } from "./src/client.js";
import {
  CambAiConfigSchema,
  resolveCambAiConfig,
  validateCambAiConfig,
  type CambAiConfig,
} from "./src/config.js";
import {
  createTtsTool,
  createTranscribeTool,
  createTranslateTool,
  createVoiceCloneTool,
  createVoiceCreateTool,
  createSoundGenerateTool,
  createAudioSeparateTool,
  createTranslatedTtsTool,
  createListVoicesTool,
  createListLanguagesTool,
} from "./src/tools/index.js";

const cambAiConfigSchema = {
  parse(value: unknown): CambAiConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    return CambAiConfigSchema.parse(raw);
  },
  uiHints: {
    apiKey: { label: "Camb AI API Key", sensitive: true },
    "tts.model": {
      label: "TTS Model",
      help: "MARS model: mars-flash (low latency), mars-pro (high fidelity), mars-instruct (instruction-following)",
    },
    "tts.defaultLanguage": {
      label: "Default TTS Language",
      help: "Language code like en-us, es-es, fr-fr",
    },
    "tts.defaultVoiceId": { label: "Default Voice ID" },
    "voiceCloning.enabled": {
      label: "Enable Voice Cloning",
      help: "Opt-in for voice cloning capabilities",
      advanced: true,
    },
    "soundGeneration.enabled": {
      label: "Enable Sound Generation",
      help: "Generate music and sound effects from text prompts",
      advanced: true,
    },
    pollingIntervalMs: { label: "Task Polling Interval (ms)", advanced: true },
    pollingTimeoutMs: { label: "Task Polling Timeout (ms)", advanced: true },
  },
};

const cambAiPlugin = {
  id: "camb-ai",
  name: "Camb AI",
  description:
    "Camb AI plugin for TTS, transcription, translation, voice cloning, and sound generation",
  configSchema: cambAiConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = resolveCambAiConfig(cambAiConfigSchema.parse(api.pluginConfig));
    const validation = validateCambAiConfig(config);

    if (!validation.valid) {
      for (const error of validation.errors) {
        api.logger.warn(`[camb-ai] ${error}`);
      }
    }

    let clientWrapper: CambClientWrapper | null = null;

    const ensureClient = (): CambClientWrapper => {
      if (!config.enabled) {
        throw new Error("Camb AI plugin is disabled in config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (!clientWrapper) {
        clientWrapper = new CambClientWrapper(config);
      }
      return clientWrapper;
    };

    // Only register tools if config is valid (API key present)
    if (config.enabled && config.apiKey) {
      const wrapper = ensureClient();

      // Register all tools
      api.registerTool(createTtsTool(wrapper, config));
      api.registerTool(createTranscribeTool(wrapper, config));
      api.registerTool(createTranslateTool(wrapper));
      api.registerTool(createVoiceCloneTool(wrapper, config));
      api.registerTool(createVoiceCreateTool(wrapper, config));
      api.registerTool(createSoundGenerateTool(wrapper, config));
      api.registerTool(createAudioSeparateTool(wrapper));
      api.registerTool(createTranslatedTtsTool(wrapper, config));
      api.registerTool(createListVoicesTool(wrapper));
      api.registerTool(createListLanguagesTool(wrapper));
    }

    // Register gateway methods for external access
    const sendError = (respond: (ok: boolean, payload?: unknown) => void, err: unknown) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod("camb.tts", async ({ params, respond }) => {
      try {
        const client = ensureClient();
        const text = typeof params?.text === "string" ? params.text.trim() : "";
        if (!text) {
          respond(false, { error: "text required" });
          return;
        }

        const voiceId =
          typeof params?.voice_id === "number" ? params.voice_id : config.tts.defaultVoiceId;

        if (!voiceId) {
          respond(false, { error: "voice_id required" });
          return;
        }

        const languageStr =
          typeof params?.language === "string"
            ? params.language.trim()
            : config.tts.defaultLanguage;

        // Map model
        const modelStr = config.tts.model;
        let speechModel: SpeechModel | undefined;
        switch (modelStr) {
          case "mars-flash":
            speechModel = "mars-flash";
            break;
          case "mars-pro":
            speechModel = "mars-pro";
            break;
          case "mars-instruct":
            speechModel = "mars-instruct";
            break;
          case "auto":
            speechModel = "auto";
            break;
          default:
            speechModel = undefined;
        }

        const response = await client.getClient().textToSpeech.tts({
          text,
          language: languageStr,
          voice_id: voiceId,
          speech_model: speechModel,
          output_configuration: {
            format: config.tts.outputFormat,
          },
        });

        // Convert to base64
        const audioBuffer = Buffer.from(await response.arrayBuffer());
        const audioBase64 = audioBuffer.toString("base64");

        respond(true, {
          format: config.tts.outputFormat,
          audio_base64: audioBase64,
          size_bytes: audioBuffer.length,
        });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("camb.voices", async ({ respond }) => {
      try {
        const client = ensureClient();
        const voices = await client.getClient().voiceCloning.listVoices();
        respond(true, { voices });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("camb.languages", async ({ params, respond }) => {
      try {
        const client = ensureClient();
        const type = params?.type === "target" ? "target" : "source";

        let languages;
        if (type === "target") {
          languages = await client.getClient().languages.getTargetLanguages();
        } else {
          languages = await client.getClient().languages.getSourceLanguages();
        }

        respond(true, { type, languages });
      } catch (err) {
        sendError(respond, err);
      }
    });

    // Register CLI commands
    api.registerCli(
      ({ program }) => {
        registerCambAiCli({
          program,
          config,
          ensureClient,
        });
      },
      { commands: ["camb"] },
    );

    api.logger.info(
      `[camb-ai] Plugin registered (enabled=${config.enabled}, voiceCloning=${config.voiceCloning.enabled}, soundGeneration=${config.soundGeneration.enabled})`,
    );
  },
};

export default cambAiPlugin;
