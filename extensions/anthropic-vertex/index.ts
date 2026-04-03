import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  mergeImplicitAnthropicVertexProvider,
  resolveAnthropicVertexConfigApiKey,
  resolveImplicitAnthropicVertexProvider,
} from "./api.js";

const PROVIDER_ID = "anthropic-vertex";

function buildAnthropicVertexReplayPolicy(modelId?: string) {
  return {
    sanitizeMode: "full" as const,
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict" as const,
    preserveSignatures: true,
    repairToolUseResultPairing: true,
    validateAnthropicTurns: true,
    allowSyntheticToolResults: true,
    ...((modelId?.toLowerCase() ?? "").includes("claude") ? { dropThinkingBlocks: true } : {}),
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Anthropic Vertex Provider",
  description: "Bundled Anthropic Vertex provider plugin",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Anthropic Vertex",
      docsPath: "/providers/models",
      auth: [],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const implicit = await resolveImplicitAnthropicVertexProvider({
            env: ctx.env,
          });
          if (!implicit) {
            return null;
          }
          return {
            provider: mergeImplicitAnthropicVertexProvider({
              existing: ctx.config.models?.providers?.[PROVIDER_ID],
              implicit,
            }),
          };
        },
      },
      resolveConfigApiKey: ({ env }) => resolveAnthropicVertexConfigApiKey(env),
      buildReplayPolicy: ({ modelId }) => buildAnthropicVertexReplayPolicy(modelId),
    });
  },
});
