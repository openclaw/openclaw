import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { createZaiToolStreamWrapper } from "../../src/agents/pi-embedded-runner/zai-stream-wrappers.js";
import { resolveRequiredHomeDir } from "../../src/infra/home-dir.js";
import { fetchZaiUsage } from "../../src/infra/provider-usage.fetch.js";

const PROVIDER_ID = "zai";
const GLM5_MODEL_ID = "glm-5";
const GLM5_TEMPLATE_MODEL_ID = "glm-4.7";

function resolveGlm5ForwardCompatModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const trimmedModelId = ctx.modelId.trim();
  const lower = trimmedModelId.toLowerCase();
  if (lower !== GLM5_MODEL_ID && !lower.startsWith(`${GLM5_MODEL_ID}-`)) {
    return undefined;
  }

  const template = ctx.modelRegistry.find(
    PROVIDER_ID,
    GLM5_TEMPLATE_MODEL_ID,
  ) as ProviderRuntimeModel | null;
  if (template) {
    return normalizeModelCompat({
      ...template,
      id: trimmedModelId,
      name: trimmedModelId,
      reasoning: true,
    } as ProviderRuntimeModel);
  }

  return normalizeModelCompat({
    id: trimmedModelId,
    name: trimmedModelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  } as ProviderRuntimeModel);
}

function resolveLegacyZaiUsageToken(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const authPath = path.join(
      resolveRequiredHomeDir(env, os.homedir),
      ".pi",
      "agent",
      "auth.json",
    );
    if (!fs.existsSync(authPath)) {
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<
      string,
      { access?: string }
    >;
    return parsed["z-ai"]?.access || parsed.zai?.access;
  } catch {
    return undefined;
  }
}

const zaiPlugin = {
  id: PROVIDER_ID,
  name: "Z.AI Provider",
  description: "Bundled Z.AI provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Z.AI",
      aliases: ["z-ai", "z.ai"],
      docsPath: "/providers/models",
      envVars: ["ZAI_API_KEY", "Z_AI_API_KEY"],
      auth: [],
      resolveDynamicModel: (ctx) => resolveGlm5ForwardCompatModel(ctx),
      prepareExtraParams: (ctx) => {
        if (ctx.extraParams?.tool_stream !== undefined) {
          return ctx.extraParams;
        }
        return {
          ...ctx.extraParams,
          tool_stream: true,
        };
      },
      wrapStreamFn: (ctx) =>
        createZaiToolStreamWrapper(ctx.streamFn, ctx.extraParams?.tool_stream !== false),
      isBinaryThinking: () => true,
      isModernModelRef: ({ modelId }) => {
        const lower = modelId.trim().toLowerCase();
        return (
          lower.startsWith("glm-5") ||
          lower.startsWith("glm-4.7") ||
          lower.startsWith("glm-4.7-flash") ||
          lower.startsWith("glm-4.7-flashx")
        );
      },
      resolveUsageAuth: async (ctx) => {
        const apiKey = ctx.resolveApiKeyFromConfigAndStore({
          providerIds: [PROVIDER_ID, "z-ai"],
          envDirect: [ctx.env.ZAI_API_KEY, ctx.env.Z_AI_API_KEY],
        });
        if (apiKey) {
          return { token: apiKey };
        }
        const legacyToken = resolveLegacyZaiUsageToken(ctx.env);
        return legacyToken ? { token: legacyToken } : null;
      },
      fetchUsageSnapshot: async (ctx) => await fetchZaiUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn),
      isCacheTtlEligible: () => true,
    });
  },
};

export default zaiPlugin;
