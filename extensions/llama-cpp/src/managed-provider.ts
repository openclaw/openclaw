import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  OpenClawPluginApi,
  ProviderWrapStreamFnContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import llamaCppProviderDiscovery from "../provider-discovery.js";
import { LLAMA_CPP_PROVIDER_ID, LLAMA_CPP_PROVIDER_LABEL } from "./defaults.js";
import { LLAMA_SERVER_DEFAULT_ORIGIN } from "./external-server/defaults.js";
import { prepareLlamaServerDynamicModel } from "./external-server/provider.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./external-server/setup.js";
import { wrapLlamaServerStream } from "./external-server/stream.js";
import { ensureManagedLlamaServerForChat, reconcileManagedLlamaServer } from "./managed-server.js";
import { detectLlamaCppSetup, prepareLlamaCppSetup, runLlamaCppSetup } from "./setup.js";

function wrapLlamaCppStream(ctx: ProviderWrapStreamFnContext): StreamFn | undefined {
  const inner = wrapLlamaServerStream(ctx);
  const providerConfig = ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (!providerConfig?.localService) {
    return inner;
  }
  const selectedModel = ctx.model;
  if (!selectedModel) {
    return undefined;
  }
  return async (...args: Parameters<typeof inner>) => {
    await ensureManagedLlamaServerForChat({
      provider: providerConfig,
      model: selectedModel,
    });
    return inner(...args);
  };
}

export function registerLlamaCppProvider(api: OpenClawPluginApi): void {
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
          detect: detectLlamaCppSetup,
          prepare: prepareLlamaCppSetup,
        },
        run: runLlamaCppSetup,
      },
      {
        id: "existing-server",
        label: "Existing llama-server",
        hint: "Connect to an existing local, private, or remote llama.cpp server",
        kind: "custom",
        wizard: {
          choiceId: "llama-cpp-existing-server",
          choiceLabel: "Existing llama-server",
          choiceHint: "Connect to a llama.cpp server managed outside OpenClaw",
          groupId: LLAMA_CPP_PROVIDER_ID,
          groupLabel: "Local llama.cpp",
          groupHint: "Managed or external llama.cpp server",
          methodId: "existing-server",
        },
        appGuidedSetup: {
          detect: detectLlamaServerSetup,
          prepare: prepareLlamaServerSetup,
        },
        run: runLlamaServerSetup,
        validateNonInteractive: validateLlamaServerNonInteractive,
        runNonInteractive: configureLlamaServerNonInteractive,
      },
    ],
    prepareDynamicModel: async (ctx) =>
      ctx.config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]?.localService
        ? undefined
        : await prepareLlamaServerDynamicModel(ctx),
    reconcileLocalService: reconcileManagedLlamaServer,
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
