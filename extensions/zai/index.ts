import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethod,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderResolveDynamicModelContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/core";
import { upsertAuthProfile } from "../../src/agents/auth-profiles.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../src/agents/defaults.js";
import { normalizeModelCompat } from "../../src/agents/model-compat.js";
import { createZaiToolStreamWrapper } from "../../src/agents/pi-embedded-runner/zai-stream-wrappers.js";
import {
  normalizeApiKeyInput,
  validateApiKeyInput,
} from "../../src/commands/auth-choice.api-key.js";
import { ensureApiKeyFromOptionEnvOrPrompt } from "../../src/commands/auth-choice.apply-helpers.js";
import { buildApiKeyCredential } from "../../src/commands/onboard-auth.credentials.js";
import {
  applyAuthProfileConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  ZAI_DEFAULT_MODEL_REF,
} from "../../src/commands/onboard-auth.js";
import { detectZaiEndpoint, type ZaiEndpointId } from "../../src/commands/zai-endpoint-detect.js";
import type { SecretInput } from "../../src/config/types.secrets.js";
import { resolveRequiredHomeDir } from "../../src/infra/home-dir.js";
import { fetchZaiUsage } from "../../src/infra/provider-usage.fetch.js";
import { normalizeOptionalSecretInput } from "../../src/utils/normalize-secret-input.js";

const PROVIDER_ID = "zai";
const GLM5_MODEL_ID = "glm-5";
const GLM5_TEMPLATE_MODEL_ID = "glm-4.7";
const PROFILE_ID = "zai:default";

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

function resolveZaiDefaultModel(modelIdOverride?: string): string {
  return modelIdOverride ? `zai/${modelIdOverride}` : ZAI_DEFAULT_MODEL_REF;
}

async function runZaiApiKeyAuth(
  ctx: ProviderAuthContext,
  endpoint?: ZaiEndpointId,
): Promise<{
  profiles: Array<{ profileId: string; credential: ReturnType<typeof buildApiKeyCredential> }>;
  configPatch: ReturnType<typeof applyZaiProviderConfig>;
  defaultModel: string;
  notes?: string[];
}> {
  let capturedSecretInput: SecretInput | undefined;
  let capturedCredential = false;
  let capturedMode: "plaintext" | "ref" | undefined;
  const apiKey = await ensureApiKeyFromOptionEnvOrPrompt({
    token:
      normalizeOptionalSecretInput(ctx.opts?.zaiApiKey) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.zaiApiKey)
      ? PROVIDER_ID
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    secretInputMode: ctx.secretInputMode,
    config: ctx.config,
    expectedProviders: [PROVIDER_ID, "z-ai"],
    provider: PROVIDER_ID,
    envLabel: "ZAI_API_KEY",
    promptMessage: "Enter Z.AI API key",
    normalize: normalizeApiKeyInput,
    validate: validateApiKeyInput,
    prompter: ctx.prompter,
    setCredential: async (key, mode) => {
      capturedSecretInput = key;
      capturedCredential = true;
      capturedMode = mode;
    },
  });
  if (!capturedCredential) {
    throw new Error("Missing Z.AI API key.");
  }
  const credentialInput = capturedSecretInput ?? "";

  const detected = await detectZaiEndpoint({ apiKey, ...(endpoint ? { endpoint } : {}) });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint;
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          credentialInput,
          undefined,
          capturedMode ? { secretInputMode: capturedMode } : undefined,
        ),
      },
    ],
    configPatch: applyZaiProviderConfig(ctx.config, {
      ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
      ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
    }),
    defaultModel: resolveZaiDefaultModel(modelIdOverride),
    ...(detected?.note ? { notes: [detected.note] } : {}),
  };
}

async function runZaiApiKeyAuthNonInteractive(
  ctx: ProviderAuthMethodNonInteractiveContext,
  endpoint?: ZaiEndpointId,
) {
  const resolved = await ctx.resolveApiKey({
    provider: PROVIDER_ID,
    flagValue: normalizeOptionalSecretInput(ctx.opts.zaiApiKey),
    flagName: "--zai-api-key",
    envVar: "ZAI_API_KEY",
  });
  if (!resolved) {
    return null;
  }
  const detected = await detectZaiEndpoint({
    apiKey: resolved.key,
    ...(endpoint ? { endpoint } : {}),
  });
  const modelIdOverride = detected?.modelId;
  const nextEndpoint = detected?.endpoint ?? endpoint;

  if (resolved.source !== "profile") {
    const credential = ctx.toApiKeyCredential({
      provider: PROVIDER_ID,
      resolved,
    });
    if (!credential) {
      return null;
    }
    upsertAuthProfile({
      profileId: PROFILE_ID,
      credential,
      agentDir: ctx.agentDir,
    });
  }

  const next = applyAuthProfileConfig(ctx.config, {
    profileId: PROFILE_ID,
    provider: PROVIDER_ID,
    mode: "api_key",
  });
  return applyZaiConfig(next, {
    ...(nextEndpoint ? { endpoint: nextEndpoint } : {}),
    ...(modelIdOverride ? { modelId: modelIdOverride } : {}),
  });
}

function buildZaiApiKeyMethod(params: {
  id: string;
  choiceId: string;
  choiceLabel: string;
  choiceHint?: string;
  endpoint?: ZaiEndpointId;
}): ProviderAuthMethod {
  return {
    id: params.id,
    label: params.choiceLabel,
    hint: params.choiceHint,
    kind: "api_key",
    wizard: {
      choiceId: params.choiceId,
      choiceLabel: params.choiceLabel,
      ...(params.choiceHint ? { choiceHint: params.choiceHint } : {}),
      groupId: "zai",
      groupLabel: "Z.AI",
      groupHint: "GLM Coding Plan / Global / CN",
    },
    run: async (ctx) => await runZaiApiKeyAuth(ctx, params.endpoint),
    runNonInteractive: async (ctx) => await runZaiApiKeyAuthNonInteractive(ctx, params.endpoint),
  };
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
      auth: [
        buildZaiApiKeyMethod({
          id: "api-key",
          choiceId: "zai-api-key",
          choiceLabel: "Z.AI API key",
        }),
        buildZaiApiKeyMethod({
          id: "coding-global",
          choiceId: "zai-coding-global",
          choiceLabel: "Coding-Plan-Global",
          choiceHint: "GLM Coding Plan Global (api.z.ai)",
          endpoint: "coding-global",
        }),
        buildZaiApiKeyMethod({
          id: "coding-cn",
          choiceId: "zai-coding-cn",
          choiceLabel: "Coding-Plan-CN",
          choiceHint: "GLM Coding Plan CN (open.bigmodel.cn)",
          endpoint: "coding-cn",
        }),
        buildZaiApiKeyMethod({
          id: "global",
          choiceId: "zai-global",
          choiceLabel: "Global",
          choiceHint: "Z.AI Global (api.z.ai)",
          endpoint: "global",
        }),
        buildZaiApiKeyMethod({
          id: "cn",
          choiceId: "zai-cn",
          choiceLabel: "CN",
          choiceHint: "Z.AI CN (open.bigmodel.cn)",
          endpoint: "cn",
        }),
      ],
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
