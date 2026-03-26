import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createChatgptAppsLinkToolFactory,
  createChatgptAppsManagedMcpServer,
  createChatgptAppsService,
} from "./chatgpt-apps/index.js";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { buildOpenAICodexProviderPlugin } from "./openai-codex-provider.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    api.registerProvider(buildOpenAIProvider());
    api.registerProvider(buildOpenAICodexProviderPlugin());
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    const chatgptAppsLinkTools = createChatgptAppsLinkToolFactory(api);
    if (chatgptAppsLinkTools) {
      api.registerTool(chatgptAppsLinkTools, {
        names: ["chatgpt_apps", "chatgpt_app_link"],
      });
    }
    const chatgptAppsService = createChatgptAppsService(api);
    if (chatgptAppsService) {
      api.registerService(chatgptAppsService);
    }
    const chatgptAppsMcpServer = createChatgptAppsManagedMcpServer(api);
    if (chatgptAppsMcpServer) {
      api.registerMcpServer(chatgptAppsMcpServer);
    }
  },
});
