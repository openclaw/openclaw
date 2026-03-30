import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  createBedrockNoCacheWrapper,
  isAnthropicBedrockModel,
} from "openclaw/plugin-sdk/provider-stream";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  mergeImplicitBedrockProvider,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";

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
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const pluginConfig = ctx.config.plugins?.entries?.["amazon-bedrock"]?.config as
            | Record<string, unknown>
            | undefined;
          const bearerToken = normalizeSecretInputString(pluginConfig?.bearerToken) ?? undefined;
          const region =
            typeof pluginConfig?.region === "string"
              ? pluginConfig.region.trim() || undefined
              : undefined;
          const implicit = await resolveImplicitBedrockProvider({
            config: ctx.config,
            env: ctx.env,
            bearerToken,
            region,
          });
          if (!implicit) {
            return null;
          }
          return {
            provider: mergeImplicitBedrockProvider({
              existing: ctx.config.models?.providers?.[PROVIDER_ID],
              implicit,
            }),
          };
        },
      },
      resolveConfigApiKey: ({ env }) => resolveBedrockConfigApiKey(env),
      wrapStreamFn: ({ modelId, streamFn }) =>
        isAnthropicBedrockModel(modelId) ? streamFn : createBedrockNoCacheWrapper(streamFn),
      resolveDefaultThinkingLevel: ({ modelId }) =>
        CLAUDE_46_MODEL_RE.test(modelId.trim()) ? "adaptive" : undefined,
    });
  },
});
