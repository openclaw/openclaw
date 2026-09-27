import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  captureProviderApiKey,
  normalizeOptionalSecretInput,
  persistProviderApiKey,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildDatabricksModelDefinition,
  DATABRICKS_DEFAULT_MODEL_REF,
  DATABRICKS_MODEL_CATALOG,
  DATABRICKS_PROVIDER_ID,
  normalizeDatabricksHost,
  resolveDatabricksBaseUrl,
} from "./models.js";
import { applyDatabricksConnectionConfig } from "./onboard.js";

const TOKEN_ENV_VAR = "DATABRICKS_TOKEN";
const HOST_ENV_VAR = "DATABRICKS_HOST";
const PROFILE_ID = "databricks:default";

function configuredBaseUrl(ctx: ProviderCatalogContext): string | undefined {
  const value = ctx.config.models?.providers?.[DATABRICKS_PROVIDER_ID]?.baseUrl;
  return typeof value === "string" && value.trim() ? value.trim().replace(/\/+$/, "") : undefined;
}

function buildDatabricksRuntimeModel(modelId: string, baseUrl: string): ProviderRuntimeModel {
  const model = buildDatabricksModelDefinition(modelId);
  const input = (model.input ?? ["text"]).filter(
    (kind): kind is "text" | "image" => kind === "text" || kind === "image",
  );
  return {
    id: model.id,
    name: model.name ?? model.id,
    provider: DATABRICKS_PROVIDER_ID,
    api: "openai-completions",
    baseUrl,
    reasoning: model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128000,
    ...(model.contextTokens !== undefined ? { contextTokens: model.contextTokens } : {}),
    maxTokens: model.maxTokens ?? 8192,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.params ? { params: model.params } : {}),
  };
}

async function resolveHostInteractive(ctx: ProviderAuthContext): Promise<string> {
  const fromEnv = normalizeDatabricksHost(
    normalizeOptionalString((ctx.env ?? process.env)[HOST_ENV_VAR]),
  );
  if (fromEnv) {
    return fromEnv;
  }
  const input = await ctx.prompter.text({
    message: "Databricks workspace URL",
    placeholder: "https://dbc-xxxxxxxx.cloud.databricks.com",
    validate: (value) =>
      normalizeDatabricksHost(normalizeOptionalString(value))
        ? undefined
        : "Enter a valid HTTPS Databricks workspace URL",
  });
  const host = normalizeDatabricksHost(normalizeOptionalString(input));
  if (!host) {
    throw new Error("A valid Databricks workspace URL is required.");
  }
  return host;
}

async function runInteractive(ctx: ProviderAuthContext) {
  const host = await resolveHostInteractive(ctx);
  const { input, mode } = await captureProviderApiKey(ctx, {
    token:
      normalizeOptionalSecretInput(ctx.opts?.databricksToken) ??
      normalizeOptionalSecretInput(ctx.opts?.token),
    tokenProvider: normalizeOptionalSecretInput(ctx.opts?.databricksToken)
      ? DATABRICKS_PROVIDER_ID
      : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
    env: ctx.env ?? process.env,
    expectedProviders: [DATABRICKS_PROVIDER_ID],
    provider: DATABRICKS_PROVIDER_ID,
    envLabel: TOKEN_ENV_VAR,
    promptMessage: "Enter Databricks token",
    missingInputMessage: "Missing Databricks token.",
  });
  return {
    profiles: [
      {
        profileId: PROFILE_ID,
        credential: buildApiKeyCredential(
          DATABRICKS_PROVIDER_ID,
          input,
          undefined,
          mode ? { secretInputMode: mode } : undefined,
        ),
      },
    ],
    configPatch: applyDatabricksConnectionConfig(ctx.config, host),
    defaultModel: DATABRICKS_DEFAULT_MODEL_REF,
  };
}

async function runNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext) {
  const resolved = await ctx.resolveApiKey({
    provider: DATABRICKS_PROVIDER_ID,
    flagValue: normalizeOptionalSecretInput(ctx.opts.databricksToken),
    flagName: "--databricks-token",
    envVar: TOKEN_ENV_VAR,
  });
  if (!resolved) {
    return null;
  }
  // Validate the workspace before persisting so a missing host leaves no orphaned credential.
  const host = normalizeDatabricksHost(normalizeOptionalString(process.env[HOST_ENV_VAR]));
  if (!host) {
    ctx.runtime.error("Databricks setup requires DATABRICKS_HOST to be set to the workspace URL.");
    ctx.runtime.exit(1);
    return null;
  }
  if (
    !(await persistProviderApiKey(ctx, PROFILE_ID, {
      provider: DATABRICKS_PROVIDER_ID,
      resolved,
    }))
  ) {
    return null;
  }
  const next = applyAuthProfileConfig(ctx.config, {
    profileId: PROFILE_ID,
    provider: DATABRICKS_PROVIDER_ID,
    mode: "api_key",
  });
  return applyDatabricksConnectionConfig(next, host);
}

export default definePluginEntry({
  id: DATABRICKS_PROVIDER_ID,
  name: "Databricks Provider",
  description: "Databricks Unity Gateway model provider plugin",
  register(api) {
    api.registerProvider({
      id: DATABRICKS_PROVIDER_ID,
      label: "Databricks",
      docsPath: "/providers/databricks",
      envVars: [TOKEN_ENV_VAR],
      auth: [
        {
          id: "api-token",
          label: "Databricks token",
          hint: "Unity Gateway / model services",
          kind: "api_key",
          wizard: {
            choiceId: "databricks-token",
            choiceLabel: "Databricks token",
            choiceHint: "Unity Gateway / model services",
            groupId: "databricks",
            groupLabel: "Databricks",
            groupHint: "Workspace token + model services",
          },
          run: runInteractive,
          runNonInteractive,
        },
      ],
      catalog: {
        order: "simple",
        run: async (ctx) => {
          const auth = ctx.resolveProviderApiKey(DATABRICKS_PROVIDER_ID);
          const baseUrl = configuredBaseUrl(ctx);
          if (!auth.apiKey || !baseUrl) {
            return null;
          }
          return {
            provider: {
              baseUrl,
              api: "openai-completions",
              apiKey: auth.apiKey,
              models: structuredClone(DATABRICKS_MODEL_CATALOG),
            },
          };
        },
      },
      resolveDynamicModel: (ctx) => {
        const baseUrl =
          ctx.providerConfig?.baseUrl ?? resolveDatabricksBaseUrl(process.env[HOST_ENV_VAR]);
        return baseUrl ? buildDatabricksRuntimeModel(ctx.modelId, baseUrl) : undefined;
      },
      ...buildProviderReplayFamilyHooks({ family: "openai-compatible" }),
    });
  },
});
