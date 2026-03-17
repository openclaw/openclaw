import { emptyPluginConfigSchema, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { openaiProvider } from "../../src/media-understanding/providers/openai/index.js";
import { buildOpenAISpeechProvider } from "../../src/tts/providers/openai.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const openAIPlugin = {
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider(buildOpenAIProvider());
    api.registerProvider(buildOpenAICodexProviderPlugin());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiProvider);
  },
};

export default openAIPlugin;
