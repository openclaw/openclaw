import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildApiKeyCredential,
  type ProviderAuthContext,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import {
  cloneFirstTemplateModel,
  normalizeGooglePreviewModelId,
  normalizeModelCompat,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
  type ModelDefinitionConfig,
  type ModelProviderConfig,
  type ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import { applyPuterModelDefault, PUTER_DEFAULT_MODEL } from "./onboard.js";

export const PROVIDER_ID = "puter";
export const PROVIDER_LABEL = "Puter";
export const PUTER_BASE_URL = "https://api.puter.com/puterai/openai/v1/";

const PUTER_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const PUTER_MODEL_DEFINITIONS: readonly ModelDefinitionConfig[] = [
  {
    id: "gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: PUTER_MODEL_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    reasoning: true,
    input: ["text", "image"],
    cost: PUTER_MODEL_COST,
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3-flash-preview",
    name: "Gemini 3 Flash",
    reasoning: true,
    input: ["text", "image"],
    cost: PUTER_MODEL_COST,
    contextWindow: 128_000,
    maxTokens: 65_536,
  },
  {
    id: "gemini-3-pro-preview",
    name: "Gemini 3 Pro",
    reasoning: true,
    input: ["text", "image"],
    cost: PUTER_MODEL_COST,
    contextWindow: 200_000,
    maxTokens: 65_536,
  },
] as const;

const PUTER_MODEL_ID_SET = new Set(PUTER_MODEL_DEFINITIONS.map((model) => model.id));
const PUTER_WIZARD_GROUP = {
  groupId: "puter",
  groupLabel: "Puter",
  groupHint: "Browser sign-in + auth token",
} as const;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizePuterBaseUrl(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimTrailingSlashes(trimmed) === trimTrailingSlashes(PUTER_BASE_URL)
    ? PUTER_BASE_URL
    : undefined;
}

function buildPuterCatalogModels(): ModelDefinitionConfig[] {
  return PUTER_MODEL_DEFINITIONS.map((model) => ({ ...model }));
}

function buildPuterCatalogProvider(apiKey?: string): ModelProviderConfig {
  return {
    baseUrl: PUTER_BASE_URL,
    api: "openai-completions",
    ...(apiKey ? { apiKey } : {}),
    models: buildPuterCatalogModels(),
  };
}

function normalizePuterModelId(modelId: string): string {
  return normalizeGooglePreviewModelId(modelId.trim());
}

function findPuterModelDefinition(modelId: string): ModelDefinitionConfig | undefined {
  return PUTER_MODEL_DEFINITIONS.find((entry) => entry.id === modelId);
}

function resolvePuterDynamicModel(
  ctx: Parameters<NonNullable<ProviderPlugin["resolveDynamicModel"]>>[0],
) {
  const normalizedModelId = normalizePuterModelId(ctx.modelId);
  if (!PUTER_MODEL_ID_SET.has(normalizedModelId)) {
    return undefined;
  }

  const patch: Partial<ProviderRuntimeModel> = {
    provider: PROVIDER_ID,
    api: "openai-completions",
    baseUrl: PUTER_BASE_URL,
    cost: PUTER_MODEL_COST,
  };

  const cloned =
    cloneFirstTemplateModel({
      providerId: PROVIDER_ID,
      modelId: normalizedModelId,
      templateIds: [normalizedModelId],
      ctx,
      patch,
    }) ??
    undefined;
  if (cloned) {
    return cloned;
  }

  const definition = findPuterModelDefinition(normalizedModelId);
  if (!definition) {
    return undefined;
  }

  return normalizeModelCompat({
    ...definition,
    provider: PROVIDER_ID,
    api: "openai-completions",
    baseUrl: PUTER_BASE_URL,
    cost: PUTER_MODEL_COST,
  } as ProviderRuntimeModel);
}

async function runPuterBrowserAuth(ctx: ProviderAuthContext): Promise<ProviderAuthResult> {
  if (ctx.isRemote) {
    await ctx.prompter.note(
      [
        "Puter browser sign-in is intended for a local machine with a default browser.",
        "For remote or VPS setup, copy a token from https://puter.com/dashboard and use Puter auth token instead.",
      ].join("\n"),
      "Puter",
    );
    return { profiles: [] };
  }

  await ctx.prompter.note(
    [
      "This opens the official Puter browser sign-in flow.",
      "No developer API key is required; the signed-in Puter account covers usage on the user-pays model.",
    ].join("\n"),
    "Puter",
  );

  const spin = ctx.prompter.progress("Starting Puter browser sign-in...");
  try {
    const { getPuterAuthToken } = await import("./auth.runtime.js");
    const token = await getPuterAuthToken();
    spin.stop("Puter sign-in complete");

    return {
      profiles: [
        {
          profileId: `${PROVIDER_ID}:default`,
          credential: buildApiKeyCredential(PROVIDER_ID, token),
        },
      ],
      configPatch: applyPuterModelDefault(ctx.config).next,
      defaultModel: PUTER_DEFAULT_MODEL,
      notes: [
        "Stored your Puter auth token for OpenClaw's Puter provider.",
      ],
    };
  } catch (error) {
    spin.stop("Puter sign-in failed");
    await ctx.prompter.note(
      [
        `Browser sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
        "If this keeps happening, copy a token from https://puter.com/dashboard and use Puter auth token setup.",
      ].join("\n"),
      "Puter",
    );
    throw error;
  }
}

export function buildPuterProvider(): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: "/providers/puter",
    envVars: ["PUTER_AUTH_TOKEN"],
    auth: [
      {
        id: "browser",
        label: "Puter browser sign-in",
        hint: "User-pays browser login",
        kind: "custom",
        wizard: {
          choiceId: "puter-browser",
          choiceLabel: "Puter browser sign-in",
          choiceHint: "User-pays browser login",
          ...PUTER_WIZARD_GROUP,
        },
        run: async (ctx) => await runPuterBrowserAuth(ctx),
      },
      createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID,
        methodId: "auth-token",
        label: "Puter auth token",
        hint: "Paste a token from puter.com/dashboard",
        optionKey: "puterAuthToken",
        flagName: "--puter-auth-token",
        envVar: "PUTER_AUTH_TOKEN",
        promptMessage: "Enter Puter auth token",
        defaultModel: PUTER_DEFAULT_MODEL,
        expectedProviders: [PROVIDER_ID],
        applyConfig: (cfg) => applyPuterModelDefault(cfg).next,
        wizard: {
          choiceId: "puter-auth-token",
          choiceLabel: "Puter auth token",
          choiceHint: "Paste a token from puter.com/dashboard",
          ...PUTER_WIZARD_GROUP,
        },
        noteTitle: "Puter",
        noteMessage: [
          "Copy your auth token from https://puter.com/dashboard.",
          "This is a user auth token for Puter's OpenAI-compatible endpoint, not a separate developer API key.",
        ].join("\n"),
      }),
    ],
    catalog: {
      order: "profile",
      run: async (ctx) => {
        const { apiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
        if (!apiKey) {
          return null;
        }
        return {
          provider: buildPuterCatalogProvider(apiKey),
        };
      },
    },
    normalizeModelId: ({ modelId }) => normalizePuterModelId(modelId),
    resolveDynamicModel: (ctx) => resolvePuterDynamicModel(ctx),
    normalizeConfig: ({ providerConfig }) => {
      const normalizedBaseUrl = normalizePuterBaseUrl(providerConfig.baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== providerConfig.baseUrl
        ? { ...providerConfig, baseUrl: normalizedBaseUrl }
        : undefined;
    },
    normalizeTransport: ({ api, baseUrl }) => {
      const normalizedBaseUrl = normalizePuterBaseUrl(baseUrl);
      return normalizedBaseUrl && normalizedBaseUrl !== baseUrl
        ? {
            api,
            baseUrl: normalizedBaseUrl,
          }
        : undefined;
    },
    isModernModelRef: ({ modelId }) =>
      PUTER_MODEL_ID_SET.has(normalizeGooglePreviewModelId(modelId.trim())),
    ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
  };
}
