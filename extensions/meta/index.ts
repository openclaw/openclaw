import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";
import { defineSingleProviderPluginEntry } from "openclaw/plugin-sdk/provider-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { runMuseLogin } from "./muse-login.js";
import { applyMetaConnectionConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { META_MODEL_CATALOG } from "./provider-catalog.js";
import { wrapMetaProviderStream } from "./stream.js";

const META_REASONING_MODELS = new Map(
  META_MODEL_CATALOG.filter((model) => model.reasoning).map((model) => [
    model.id.toLowerCase(),
    model,
  ]),
);

const META_THINKING_LEVEL_IDS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const META_THINKING_PROFILE = {
  levels: META_THINKING_LEVEL_IDS.map((id) => ({ id })),
  defaultLevel: "high",
} satisfies ProviderThinkingProfile;

const META_MAX_THINKING_PROFILE = {
  ...META_THINKING_PROFILE,
  levels: [...META_THINKING_PROFILE.levels, { id: "max" }],
} satisfies ProviderThinkingProfile;

const PROVIDER_ID = "meta";

export default defineSingleProviderPluginEntry({
  id: PROVIDER_ID,
  name: "Meta Provider",
  description: "Meta provider plugin",
  manifest,
  provider: {
    label: "Meta",
    docsPath: "/providers/meta",
    manifestAuth: {
      applyConfig: applyMetaConnectionConfig,
      noteMessage: "Meta provides Responses API inference.",
      noteTitle: "Meta",
    },
    extraAuth: [
      {
        id: "muse-code",
        label: "Muse Code",
        kind: "device_code",
        starterModel: "meta/muse-spark-1.3",
        run: runMuseLogin,
      },
    ],
    catalog: { discoveryMode: "strict", liveModelDiscovery: true },
    ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    wrapSimpleCompletionStreamFn: wrapMetaProviderStream,
    wrapStreamFn: wrapMetaProviderStream,
    resolveThinkingProfile: (context) => {
      // Some control-plane callers have no runtime catalog. Fall back to the
      // process-stable manifest so those paths retain the same model policy.
      const catalogModel = META_REASONING_MODELS.get(context.modelId.toLowerCase());
      if (!(context.reasoning ?? catalogModel?.reasoning)) {
        return undefined;
      }
      const efforts =
        context.compat?.supportedReasoningEfforts ?? catalogModel?.compat.supportedReasoningEfforts;
      return context.thinkingLevelMap?.max !== null && efforts?.includes("max")
        ? META_MAX_THINKING_PROFILE
        : META_THINKING_PROFILE;
    },
  },
});
