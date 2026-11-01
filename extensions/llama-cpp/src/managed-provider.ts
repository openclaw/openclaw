import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import type {
  OpenClawPluginApi,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { llamaCppProviderDiscovery } from "../provider-discovery.js";
import { LLAMA_CPP_PROVIDER_ID, LLAMA_CPP_PROVIDER_LABEL } from "./defaults.js";
import { LLAMA_CPP_SERVER, LLAMA_SERVER_DEFAULT_ORIGIN } from "./external-server/defaults.js";
import { createLlamaServerAuthMethod } from "./external-server/registration.js";

function wrapLlamaCppStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const providerConfig = ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const selectedModel = ctx.model;
  if (providerConfig?.localService && !selectedModel) {
    return undefined;
  }
  return async (...args) => {
    const { wrapLlamaServerStream } = await import("./external-server/stream.js");
    if (providerConfig?.localService && selectedModel) {
      const { ensureManagedLlamaServerForChat } = await import("./managed-server.js");
      const signal = args[2]?.signal;
      signal?.throwIfAborted();
      await ensureManagedLlamaServerForChat({
        provider: providerConfig,
        model: selectedModel,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
    }
    return wrapLlamaServerStream(ctx)(...args);
  };
}

export function registerLlamaCppProvider(
  api: OpenClawPluginApi,
  mediaProvider: MediaUnderstandingProvider,
): void {
  api.registerProvider({
    ...llamaCppProviderDiscovery,
    auth: [
      {
        id: "local",
        label: LLAMA_CPP_PROVIDER_LABEL,
        hint: "Choose a Qwen, Gemma, or Muse model for this Gateway’s hardware and install llama.cpp",
        kind: "custom",
        wizard: {
          choiceId: LLAMA_CPP_PROVIDER_ID,
          choiceLabel: "Managed local server",
          choiceHint:
            "Choose a Qwen, Gemma, or Muse model for this Gateway’s hardware and install llama.cpp",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "Managed or external llama.cpp server",
          methodId: "local",
        },
        appGuidedSetup: {
          detect: async (ctx) => (await import("./setup.js")).detectLlamaCppSetup(ctx),
          prepare: async (ctx) => (await import("./setup.js")).prepareLlamaCppSetup(ctx),
        },
        run: async (ctx) => (await import("./setup.js")).runLlamaCppSetup(ctx),
        runNonInteractive: async (ctx) =>
          (await import("./setup.js")).configureLlamaCppNonInteractive(ctx),
      },
      createLlamaServerAuthMethod(LLAMA_CPP_SERVER),
      {
        id: "local-media",
        label: "Managed local OCR and vision",
        hint: "Recommend, install and verify local image models for this Gateway",
        kind: "custom",
        run: async (ctx) => {
          const { runLlamaCppMediaSetup } = await import("./media-setup.js");
          return await runLlamaCppMediaSetup(ctx, mediaProvider);
        },
      },
    ],
    prepareDynamicModel: async (ctx) => {
      if (ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.localService) {
        return undefined;
      }
      const { prepareLlamaServerDynamicModel } = await import("./external-server/provider.js");
      return prepareLlamaServerDynamicModel(ctx);
    },
    reconcileLocalService: async (ctx) =>
      (await import("./managed-server.js")).reconcileManagedLlamaServer(ctx),
    wrapSimpleCompletionStreamFn: wrapLlamaCppStream,
    wrapStreamFn: wrapLlamaCppStream,
    ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
    wizard: {
      modelPicker: {
        label: "llama.cpp",
        hint: `Use a managed server or connect to ${LLAMA_SERVER_DEFAULT_ORIGIN}`,
        methodId: "local",
      },
    },
  });
}
