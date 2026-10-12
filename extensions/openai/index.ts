import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
} from "openclaw/plugin-sdk/provider-model-metadata";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openaiMediaUnderstandingProvider } from "./media-understanding-provider.js";
import { openAiMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import {
  acquireOpenAIQuicksilverBrowserSessionBroker,
  releaseOpenAIQuicksilverBrowserSessionBroker,
} from "./realtime-quicksilver-session-owner.js";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import { buildOpenAIRealtimeTranscriptionProvider } from "./realtime-transcription-provider-factory.js";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider-factory.js";
import { buildOpenAISpeechProvider } from "./speech-provider.js";

export default definePluginEntry({
  id: "openai",
  name: "OpenAI Provider",
  description: "Bundled OpenAI provider plugins",
  register(api) {
    const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks("openai");
    const provider = buildOpenAIProvider();
    api.registerProvider({
      ...provider,
      ...openAIToolCompatHooks,
      resolveSystemPromptContribution: (ctx) => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, "openai");
        const pluginConfig =
          runtimePluginConfig ??
          (ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>));
        return resolveGpt5SystemPromptContribution({
          config: ctx.config,
          legacyPluginConfig: {
            personality: resolveGpt5PromptOverlayMode(undefined, pluginConfig),
          },
          modelId: ctx.modelId,
          trigger: ctx.trigger,
        });
      },
    });
    api.registerEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider(api.runtime.modelAuth));
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider);
    api.registerRealtimeVoiceProvider((context) => {
      const quicksilverSession =
        api.registrationMode === "full"
          ? acquireOpenAIQuicksilverBrowserSessionBroker(
              {
                getConfig: () => api.runtime.config.current() as OpenClawConfig,
                logger: api.logger,
              },
              context,
            )
          : undefined;
      if (quicksilverSession) {
        api.registerHttpRoute({
          path: OPENAI_QUICKSILVER_OFFER_PATH,
          auth: "plugin",
          match: "exact",
          handler: quicksilverSession.handler,
        });
        api.lifecycle.registerRuntimeLifecycle({
          id: "openai-quicksilver-realtime-browser-session",
          description: "Close OpenAI browser sidebands when the plugin stops",
          cleanup: (ctx) => {
            if (ctx.reason !== "disable") {
              return undefined;
            }
            return releaseOpenAIQuicksilverBrowserSessionBroker(quicksilverSession);
          },
        });
      }
      return buildOpenAIRealtimeVoiceProvider(context, {
        quicksilverBrowserSessionBroker: quicksilverSession?.broker,
        logger: api.logger,
      });
    });
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
  },
});
