import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { readConfiguredProviderCatalogEntries } from "openclaw/plugin-sdk/provider-catalog-shared";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  applyOpenAICompletionsToolReasoning,
  createPayloadPatchStreamWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { buildProviderToolCompatFamilyHooks } from "openclaw/plugin-sdk/provider-tools";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const PROVIDER_ID = "gmi";

function wrapGmiOpenAIToolReasoning(ctx: ProviderWrapStreamFnContext) {
  const wrapped = createPayloadPatchStreamWrapper(ctx.streamFn, ({ model, payload }) => {
    if ((ctx.sourceApi ?? model.api) === "openai-completions" && model.id.startsWith("openai/")) {
      applyOpenAICompletionsToolReasoning(payload, { id: model.id.slice("openai/".length) });
    }
  });
  return Object.assign(wrapped, { preservesGenericCompatibility: true });
}

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "GMI Cloud Provider",
  description: "GMI Cloud provider plugin",
  manifest,
  provider: {
    label: "GMI Cloud",
    docsPath: "/providers/gmi",
    aliases: ["gmi-cloud", "gmicloud"],
    manifestAuth: {
      noteTitle: "GMI Cloud",
      noteMessage: "Manage API keys at https://www.gmicloud.ai/",
    },
    catalog: {
      discoveryMode: "strict",
      allowExplicitBaseUrl: true,
      liveModelDiscovery: true,
    },
    augmentModelCatalog: ({ config }) =>
      readConfiguredProviderCatalogEntries({
        config,
        providerId: PROVIDER_ID,
      }),
    ...buildProviderReplayFamilyHooks({
      family: "openai-compatible",
      dropReasoningFromHistory: false,
    }),
    ...buildProviderToolCompatFamilyHooks("openai"),
    wrapStreamFn: wrapGmiOpenAIToolReasoning,
    wrapSimpleCompletionStreamFn: wrapGmiOpenAIToolReasoning,
  },
});
