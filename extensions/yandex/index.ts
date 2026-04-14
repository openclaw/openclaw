import type {
  ProviderAuthContext,
  ProviderAuthMethod,
  ProviderAuthMethodNonInteractiveContext,
  ProviderAuthResult,
} from "openclaw/plugin-sdk/core";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureApiKeyFromOptionEnvOrPrompt,
  normalizeApiKeyInput,
  normalizeOptionalSecretInput,
  type SecretInput,
  upsertAuthProfile,
  validateApiKeyInput,
} from "openclaw/plugin-sdk/provider-auth";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { applyYandexConfig, YANDEX_DEFAULT_MODEL_REF } from "./onboard.js";
import { YANDEX_BASE_URL } from "./models.js";
import { buildYandexProvider } from "./provider-catalog.js";

const PROVIDER_ID = "yandex";

/**
 * Single auth method that prompts for both the API key and the folder ID in
 * one onboarding step, matching the Yandex AI Studio setup requirements.
 *
 * Both values are required together because the API key is folder-scoped and
 * cannot be used with a different folder ID.
 *
 * @see https://yandex.cloud/en/docs/ai-studio/quickstart/yandexgpt
 */
const yandexApiKeyAuthMethod: ProviderAuthMethod = {
  id: "api-key",
  label: "Yandex AI Studio API key + folder ID",
  hint: "API key and folder ID from Yandex AI Studio",
  kind: "api_key",
  wizard: {
    choiceId: "yandex-api-key",
    choiceLabel: "Yandex AI Studio API key",
    groupId: "yandex",
    groupLabel: "Yandex",
    groupHint: "YandexGPT and other models via AI Studio",
  },
  run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
    const opts = ctx.opts as Record<string, unknown> | undefined;

    // Step 1: API key
    let capturedApiKey: SecretInput | undefined;
    await ensureApiKeyFromOptionEnvOrPrompt({
      token: normalizeOptionalSecretInput(opts?.yandexApiKey),
      tokenProvider: PROVIDER_ID,
      secretInputMode: ctx.secretInputMode,
      config: ctx.config,
      env: ctx.env,
      expectedProviders: [PROVIDER_ID],
      provider: PROVIDER_ID,
      envLabel: "YANDEX_API_KEY",
      promptMessage: "Enter Yandex AI Studio API key",
      normalize: normalizeApiKeyInput,
      validate: validateApiKeyInput,
      prompter: ctx.prompter,
      setCredential: async (apiKey) => {
        capturedApiKey = apiKey;
      },
    });

    if (!capturedApiKey) {
      throw new Error("Yandex AI Studio API key is required.");
    }

    // Step 2: Folder ID (prompted immediately after the API key)
    const providedFolderId =
      typeof opts?.yandexFolderId === "string" && opts.yandexFolderId.trim()
        ? opts.yandexFolderId.trim()
        : (process.env["YANDEX_FOLDER_ID"] ?? "").trim() || undefined;

    const folderId = providedFolderId
      ? providedFolderId
      : (
          await ctx.prompter.text({
            message: "Enter Yandex Cloud folder ID",
            placeholder: "b1g...",
            validate: (v) => (v.trim() ? undefined : "Folder ID is required"),
          })
        ).trim();

    if (!folderId) {
      throw new Error("Yandex Cloud folder ID is required.");
    }

    return {
      profiles: [
        {
          profileId: `${PROVIDER_ID}:default`,
          credential: buildApiKeyCredential(
            PROVIDER_ID,
            capturedApiKey,
            undefined,
            ctx.secretInputMode ? { secretInputMode: ctx.secretInputMode, config: ctx.config } : undefined,
          ),
        },
      ],
      configPatch: {
        models: {
          providers: {
            [PROVIDER_ID]: {
              baseUrl: YANDEX_BASE_URL,
              api: "openai-completions" as const,
              headers: { "OpenAI-Project": folderId },
            },
          },
        },
      },
      defaultModel: YANDEX_DEFAULT_MODEL_REF,
      notes: [
        `Folder ID: ${folderId}`,
        "Models: yandex/aliceai-llm, yandex/yandexgpt/latest, yandex/yandexgpt/rc, yandex/yandexgpt-lite/latest",
      ],
    };
  },
  runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
    const opts = ctx.opts as Record<string, unknown> | undefined;

    // Resolve API key from flag / env
    const resolved = await ctx.resolveApiKey({
      provider: PROVIDER_ID,
      flagValue: normalizeOptionalSecretInput(opts?.yandexApiKey),
      flagName: "--yandex-api-key",
      envVar: "YANDEX_API_KEY",
    });
    if (!resolved) {
      return null;
    }

    // Resolve folder ID from flag / env
    const folderId =
      (typeof opts?.yandexFolderId === "string" && opts.yandexFolderId.trim()
        ? opts.yandexFolderId.trim()
        : undefined) ?? (process.env["YANDEX_FOLDER_ID"] ?? "").trim() || undefined;

    if (!folderId) {
      ctx.runtime.error(
        "Yandex Cloud folder ID is required. Provide it via --yandex-folder-id or YANDEX_FOLDER_ID env var.",
      );
      ctx.runtime.exit(1);
      return null;
    }

    if (resolved.source !== "profile") {
      const credential = ctx.toApiKeyCredential({
        provider: PROVIDER_ID,
        resolved,
      });
      if (!credential) {
        return null;
      }
      upsertAuthProfile({
        profileId: `${PROVIDER_ID}:default`,
        credential,
        agentDir: ctx.agentDir,
      });
    }

    const next = applyAuthProfileConfig(
      applyYandexConfig(ctx.config),
      {
        profileId: `${PROVIDER_ID}:default`,
        provider: PROVIDER_ID,
        mode: "api_key",
      },
    );

    return {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models?.providers,
          [PROVIDER_ID]: {
            ...(next.models?.providers?.[PROVIDER_ID] ?? {}),
            headers: { "OpenAI-Project": folderId },
          },
        },
      },
    };
  },
};

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Yandex Provider",
  description: "Bundled Yandex AI Studio provider plugin (YandexGPT)",
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Yandex",
      docsPath: "/providers/yandex",
      envVars: ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"],
      auth: [yandexApiKeyAuthMethod],
      catalog: {
        order: "simple",
        run: (ctx) =>
          Promise.resolve({
            provider: buildYandexProvider(
              ctx.config.models?.providers?.[PROVIDER_ID]?.headers?.["OpenAI-Project"] as
                | string
                | undefined,
            ),
          }),
      },
    });
  },
});
