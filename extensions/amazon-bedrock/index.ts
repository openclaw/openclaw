import { definePluginEntry } from "openclaw/plugin-sdk/core";
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
      wrapStreamFn: ({ modelId, config, provider, streamFn }) => {
        // Look up model name from provider config for inference profile detection
        let modelName: string | undefined;
        const providerConfig = config?.models?.providers?.[provider];
        if (providerConfig?.models) {
          const modelDef = (providerConfig.models as Array<{ id?: string; name?: string }>).find(
            (m) => m.id === modelId,
          );
          modelName = modelDef?.name;
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
