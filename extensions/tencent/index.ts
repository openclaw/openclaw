import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildOpenAICompatibleProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createProviderConnectionPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import {
  buildTokenHubProvider,
  buildTokenPlanProvider,
  TENCENT_PROVIDER_CATALOG,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL_CATALOG,
  TOKENPLAN_PROVIDER_ID,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TENCENT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_PROVIDER_ID,
]);

type StreamOptions = NonNullable<Parameters<StreamFn>[2]> & { reasoningEffort?: unknown };

// Only hy3 has a verified two-rung override. Other models retain shared effort handling.
const TENCENT_TWO_RUNG_EFFORT_MAP: Readonly<Record<string, string>> = {
  off: "none",
  none: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
};

const TENCENT_PROVIDERS = [
  {
    providerId: TOKENHUB_PROVIDER_ID,
    label: "Tencent TokenHub",
    optionKey: "tokenhubApiKey",
    flagName: "--tokenhub-api-key",
    envVar: "TOKENHUB_API_KEY",
    defaultModel: readManifestProviderDefaultModelRef(manifest, TOKENHUB_PROVIDER_ID)!,
    baseUrl: TOKENHUB_BASE_URL,
    catalogModels: TOKENHUB_MODEL_CATALOG,
    // Specific model aliases must not follow the manifest's changing default.
    aliases: [
      { modelRef: `${TOKENHUB_PROVIDER_ID}/hy4-preview`, alias: "Hy4 preview (TokenHub)" },
      { modelRef: `${TOKENHUB_PROVIDER_ID}/hy3`, alias: "Hy3 (TokenHub)" },
      { modelRef: `${TOKENHUB_PROVIDER_ID}/hy3-preview`, alias: "Hy3 preview (TokenHub)" },
    ],
    choiceId: "tokenhub-api-key",
    buildProvider: buildTokenHubProvider,
  },
  {
    providerId: TOKENPLAN_PROVIDER_ID,
    label: "Tencent TokenPlan",
    optionKey: "tokenplanApiKey",
    flagName: "--tokenplan-api-key",
    envVar: "TOKENPLAN_API_KEY",
    defaultModel: readManifestProviderDefaultModelRef(manifest, TOKENPLAN_PROVIDER_ID)!,
    baseUrl: TOKENPLAN_BASE_URL,
    catalogModels: TOKENPLAN_MODEL_CATALOG,
    aliases: [
      { modelRef: `${TOKENPLAN_PROVIDER_ID}/hy4-preview`, alias: "Hy4 preview (TokenPlan)" },
      { modelRef: `${TOKENPLAN_PROVIDER_ID}/hy3`, alias: "Hy3 (TokenPlan)" },
    ],
    choiceId: "tokenplan-api-key",
    buildProvider: buildTokenPlanProvider,
  },
] as const;

export default definePluginEntry({
  id: "tencent",
  name: "Tencent Cloud Provider",
  description: "Bundled Tencent Cloud provider plugin (TokenHub, TokenPlan)",
  register(api) {
    for (const provider of TENCENT_PROVIDERS) {
      const { applyConfig } = createProviderConnectionPresetAppliers<[]>({
        primaryModelRef: provider.defaultModel,
        resolveParams: () => ({
          providerId: provider.providerId,
          api: "openai-completions",
          baseUrl: provider.baseUrl,
          catalogModels: provider.catalogModels,
          aliases: provider.aliases,
        }),
      });
      api.registerProvider({
        id: provider.providerId,
        label: provider.label,
        docsPath: "/providers/tencent",
        envVars: [provider.envVar],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: provider.providerId,
            methodId: "api-key",
            label: provider.label,
            hint: `Hy via ${provider.label} Gateway`,
            optionKey: provider.optionKey,
            flagName: provider.flagName,
            envVar: provider.envVar,
            promptMessage: `Enter ${provider.label} API key`,
            defaultModel: provider.defaultModel,
            expectedProviders: [provider.providerId],
            applyConfig,
            wizard: {
              choiceId: provider.choiceId,
              choiceLabel: provider.label,
              groupId: "tencent",
              groupLabel: "Tencent Cloud",
              groupHint: provider.label,
            },
          }),
        ],
        catalog: {
          order: "simple",
          run: (ctx) =>
            buildOpenAICompatibleProviderCatalog({
              discoveryMode: "strict",
              ctx,
              providerId: provider.providerId,
              buildProvider: provider.buildProvider,
            }),
        },
        staticCatalog: {
          order: "simple",
          run: async () => ({ provider: provider.buildProvider() }),
        },
        augmentModelCatalog: () =>
          TENCENT_PROVIDER_CATALOG.augmentModelCatalog().filter(
            (entry) => entry.provider === provider.providerId,
          ),
        wrapStreamFn: (ctx) =>
          createPayloadPatchStreamWrapper(
            ctx.streamFn,
            ({ payload, options }) => {
              const streamOptions: StreamOptions | undefined = options;
              const raw =
                (typeof streamOptions?.reasoningEffort === "string" &&
                  streamOptions.reasoningEffort) ||
                streamOptions?.reasoning ||
                ctx.thinkingLevel;
              const requested = raw ? raw.trim().toLowerCase() : undefined;
              const mapped =
                requested && Object.hasOwn(TENCENT_TWO_RUNG_EFFORT_MAP, requested)
                  ? TENCENT_TWO_RUNG_EFFORT_MAP[requested]
                  : undefined;
              if (mapped !== undefined) {
                payload.reasoning_effort = mapped;
              }
            },
            {
              shouldPatch: ({ model }) =>
                TENCENT_PROVIDER_IDS.has(model.provider) &&
                model.api === "openai-completions" &&
                model.id === "hy3",
            },
          ),
      });
    }
  },
});
