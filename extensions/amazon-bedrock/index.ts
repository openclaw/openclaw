import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-models";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "openclaw/plugin-sdk/provider-stream";

const PROVIDER_ID = "amazon-bedrock";
const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Amazon Bedrock Provider",
  description: "Bundled Amazon Bedrock provider policy plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Amazon Bedrock",
      docsPath: "/providers/models",
      auth: [],
      wrapStreamFn: ({ modelId, config, streamFn }) => {
        // Look up model name from provider config for inference profile detection.
        // Use normalized key matching so aliases like "bedrock" / "aws-bedrock" are found.
        let modelName: string | undefined;
        const providers = config?.models?.providers;
        if (providers) {
          for (const [key, value] of Object.entries(providers)) {
            if (normalizeProviderId(key) !== PROVIDER_ID) continue;
            const models = (value as { models?: Array<{ id?: string; name?: string }> })?.models;
            const modelDef = models?.find((m) => m.id === modelId);
            if (modelDef?.name) {
              modelName = modelDef.name;
              break;
            }
          }
        }
        return isAnthropicBedrockModel(modelId, modelName)
          ? streamFn
          : createBedrockNoCacheWrapper(streamFn);
      },
      resolveDefaultThinkingLevel: ({ modelId }) =>
        CLAUDE_46_MODEL_RE.test(modelId.trim()) ? "adaptive" : undefined,
    });
  },
});
