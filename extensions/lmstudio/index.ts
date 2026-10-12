import {
  createLazyRuntimeMethodBinder,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import {
  definePluginEntry,
  type OpenClawConfig,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CUSTOM_LOCAL_AUTH_MARKER,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import { lmstudioMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";
import lmstudioProviderDiscovery from "./provider-discovery.js";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_PROVIDER_LABEL } from "./src/defaults.js";
import {
  normalizeLmstudioConfiguredCatalogEntries,
  normalizeLmstudioProviderConfig,
} from "./src/models.js";
import { wrapLmstudioInferencePreload } from "./src/stream.js";

const PROVIDER_ID = "lmstudio";
const loadSetup = createLazyRuntimeModule(() => import("./src/setup.js"));
const setupMethod = createLazyRuntimeMethodBinder(loadSetup);

function resolveLmstudioAugmentedCatalogEntries(config: OpenClawConfig | undefined) {
  return normalizeLmstudioConfiguredCatalogEntries(config?.models?.providers?.lmstudio?.models).map(
    (entry) =>
      Object.assign({}, entry, {
        provider: PROVIDER_ID,
        name: entry.name ?? entry.id,
        compat: { ...entry.compat, supportsUsageInStreaming: true },
      }),
  );
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "LM Studio Provider",
  description: "Bundled LM Studio provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerEmbeddingProvider(lmstudioMemoryEmbeddingProviderAdapter);
    api.registerProvider({
      ...lmstudioProviderDiscovery,
      auth: [
        {
          id: "custom",
          label: LMSTUDIO_PROVIDER_LABEL,
          hint: "Connect to a running LM Studio server and use an already loaded model",
          kind: "custom",
          appGuidedSetup: {
            detectAvailability: setupMethod((setup) => setup.detectAppGuidedLmstudioAvailability),
            detect: async (ctx) => {
              const providerSetup = await loadSetup();
              const result = await providerSetup.prepareAppGuidedLmstudioSetup(ctx);
              if (!result?.defaultModel) {
                return null;
              }
              const provider = result.configPatch?.models?.providers?.[PROVIDER_ID];
              return {
                modelRef: result.defaultModel,
                detail: `${result.defaultModel.slice(`${PROVIDER_ID}/`.length)} at ${provider?.baseUrl ?? "LM Studio"}`,
              };
            },
            prepare: setupMethod((setup) => setup.prepareAppGuidedLmstudioSetup),
          },
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const providerSetup = await loadSetup();
            const suppliedApiKey =
              ctx.opts?.tokenProvider === PROVIDER_ID
                ? normalizeOptionalSecretInput(ctx.opts.token)
                : undefined;
            return await providerSetup.promptAndConfigureLmstudioInteractive({
              config: ctx.config,
              agentDir: ctx.agentDir,
              workspaceDir: ctx.workspaceDir,
              prompter: ctx.prompter,
              secretInputMode: ctx.secretInputMode,
              allowSecretRefPrompt: ctx.allowSecretRefPrompt,
              isRemote: ctx.isRemote,
              signal: ctx.signal,
              ...(suppliedApiKey
                ? {
                    suppliedApiKey,
                    requestedModelId: normalizeOptionalSecretInput(ctx.opts?.customModelId),
                  }
                : {}),
            });
          },
          validateNonInteractive: setupMethod((setup) => setup.validateLmstudioNonInteractive),
          runNonInteractive: setupMethod((setup) => setup.configureLmstudioNonInteractive),
        },
      ],
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER ||
        resolvedApiKey?.trim() === CUSTOM_LOCAL_AUTH_MARKER,
      normalizeConfig: ({ providerConfig }) => normalizeLmstudioProviderConfig(providerConfig),
      prepareDynamicModel: setupMethod((setup) => setup.prepareLmstudioDynamicModel),
      augmentModelCatalog: (ctx) => resolveLmstudioAugmentedCatalogEntries(ctx.config),
      wrapStreamFn: wrapLmstudioInferencePreload,
      ...buildProviderToolCompatFamilyHooks("llamacpp-gbnf"),
      wizard: {
        setup: {
          choiceId: PROVIDER_ID,
          choiceLabel: "LM Studio",
          choiceHint: "Connect to a running LM Studio server and use an already loaded model",
          groupId: PROVIDER_ID,
          groupLabel: "LM Studio",
          groupHint: "Self-hosted open-weight models",
          methodId: "custom",
        },
        modelPicker: {
          label: "LM Studio (custom)",
          hint: "Detect models from LM Studio /api/v1/models",
          methodId: "custom",
        },
      },
    });
  },
});
