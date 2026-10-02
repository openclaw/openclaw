import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  applyProviderAuthConfigPatch,
  normalizeOptionalSecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  captureProviderApiKey,
  persistProviderApiKey,
} from "openclaw/plugin-sdk/provider-auth-api-key";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig, OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  applyProviderDefaultModel,
  SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
  SELF_HOSTED_DEFAULT_COST,
  SELF_HOSTED_DEFAULT_MAX_TOKENS,
} from "openclaw/plugin-sdk/provider-setup";
import {
  BIFROST_BASE_URL,
  normalizeBifrostBaseUrl,
  tryNormalizeBifrostBaseUrl,
} from "./defaults.js";
import { listBifrostModels } from "./models.js";
import { buildBifrostConnectionConfig, applyBifrostModelConfig } from "./onboard.js";

function manualModel(config: OpenClawConfig, id: string): ModelDefinitionConfig {
  return (
    config.models?.providers?.bifrost?.models.find((model) => model.id === id) ?? {
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: SELF_HOSTED_DEFAULT_COST,
      contextWindow: SELF_HOSTED_DEFAULT_CONTEXT_WINDOW,
      maxTokens: SELF_HOSTED_DEFAULT_MAX_TOKENS,
    }
  );
}

export async function configureBifrostInteractive(ctx: ProviderAuthContext) {
  const configured = resolveMergedModelProviderConfig(ctx.config, "bifrost")?.baseUrl;
  const baseUrl = normalizeBifrostBaseUrl(
    (await ctx.prompter.text({
      message: "Bifrost gateway base URL",
      initialValue: configured,
      placeholder: BIFROST_BASE_URL,
      validate: (value) => {
        if (!value.trim()) {
          return undefined;
        }
        return tryNormalizeBifrostBaseUrl(value) ? undefined : "Enter an HTTP or HTTPS gateway URL";
      },
    })) ||
      configured ||
      BIFROST_BASE_URL,
  );
  const flagValue = normalizeOptionalSecretInput(ctx.opts?.bifrostApiKey);
  const token = flagValue ?? normalizeOptionalSecretInput(ctx.opts?.token);
  const wantsKey =
    token ||
    (await ctx.prompter.confirm({
      message: "Does this Bifrost gateway require a virtual key?",
      initialValue: false,
    }));
  const captured = wantsKey
    ? await captureProviderApiKey(ctx, {
        provider: "bifrost",
        expectedProviders: ["bifrost"],
        envLabel: "BIFROST_VIRTUAL_KEY",
        promptMessage: "Enter Bifrost virtual key",
        token,
        tokenProvider: flagValue
          ? "bifrost"
          : normalizeOptionalSecretInput(ctx.opts?.tokenProvider),
        env: ctx.env,
      })
    : undefined;
  let config = applyProviderAuthConfigPatch(
    ctx.config,
    buildBifrostConnectionConfig(ctx.config, baseUrl, !captured),
  );
  let model: ModelDefinitionConfig | undefined;
  if (!ctx.credentialOnly) {
    let models: ModelDefinitionConfig[] = [];
    try {
      models = (
        await listBifrostModels({
          config,
          apiKey: captured?.apiKey,
          env: ctx.env,
          signal: ctx.signal,
          beforeRequest: ctx.assertCurrent,
        })
      ).models;
    } catch {
      // Discovery is advisory; authority and cancellation remain terminal below.
    }
    ctx.signal?.throwIfAborted();
    ctx.assertCurrent?.();
    const selected = models.length
      ? await ctx.prompter.select({
          message: "Bifrost model",
          initialValue: models[0]?.id,
          options: [
            ...models.map((entry) => ({ value: entry.id, label: entry.name })),
            { value: "", label: "Enter model ID manually" },
          ],
        })
      : "";
    if (!models.length) {
      await ctx.prompter.note(
        "No models were discovered. Check the gateway URL and authentication, or enter a model ID manually.",
        "Bifrost models",
      );
    }
    const id =
      selected ||
      (
        await ctx.prompter.text({
          message: "Bifrost model ID",
          placeholder: "Model ID served by your gateway, such as ollama/qwen3:4b",
          validate: (value) => (value.trim() ? undefined : "Model ID is required"),
        })
      ).trim();
    model = models.find((entry) => entry.id === id) ?? manualModel(config, id);
    config = applyBifrostModelConfig(config, model);
  }
  return {
    profiles: captured
      ? [
          {
            profileId: "bifrost:default",
            credential: buildApiKeyCredential("bifrost", captured.input, undefined, {
              secretInputMode: captured.mode,
              config,
            }),
          },
        ]
      : [],
    configPatch: buildBifrostConnectionConfig(config, baseUrl, !captured),
    ...(model ? { defaultModel: `bifrost/${model.id}` } : {}),
  };
}

export async function configureBifrostNonInteractive(ctx: ProviderAuthMethodNonInteractiveContext) {
  const baseUrl = tryNormalizeBifrostBaseUrl(
    normalizeOptionalSecretInput(ctx.opts.customBaseUrl) ||
      resolveMergedModelProviderConfig(ctx.config, "bifrost")?.baseUrl ||
      BIFROST_BASE_URL,
  );
  const existing = resolveMergedModelProviderConfig(ctx.config, "bifrost");
  const flagValue = normalizeOptionalSecretInput(ctx.opts.bifrostApiKey ?? ctx.opts.customApiKey);
  const anonymous = ctx.opts.customNoAuth === true || (existing?.auth === "none" && !flagValue);
  const resolved = anonymous
    ? null
    : await ctx.resolveApiKey({
        provider: "bifrost",
        flagValue,
        allowProfile:
          baseUrl !== undefined &&
          (!existing || tryNormalizeBifrostBaseUrl(existing.baseUrl) === baseUrl),
        flagName: "--bifrost-api-key",
        envVar: "BIFROST_VIRTUAL_KEY",
        required: false,
      });
  if (!baseUrl) {
    ctx.runtime.error(
      `The Bifrost gateway URL must be a full http:// or https:// URL, such as ${BIFROST_BASE_URL}.`,
    );
    ctx.runtime.exit(1);
    return null;
  }
  if (!resolved && !anonymous) {
    ctx.runtime.error(
      "Bifrost requires a virtual key or --custom-no-auth for anonymous inference.",
    );
    ctx.runtime.exit(1);
    return null;
  }
  let config = applyProviderAuthConfigPatch(
    ctx.config,
    buildBifrostConnectionConfig(ctx.config, baseUrl, !resolved),
  );
  const explicitId = normalizeOptionalSecretInput(ctx.opts.customModelId);
  let model = explicitId ? manualModel(config, explicitId) : undefined;
  if (!model) {
    try {
      model = (await listBifrostModels({ config, apiKey: resolved?.key })).models[0];
    } catch {
      // The failure below gives non-interactive callers an actionable next step.
    }
  }
  if (!model) {
    ctx.runtime.error(
      "No Bifrost models were discovered. Check the gateway or pass --custom-model-id.",
    );
    ctx.runtime.exit(1);
    return null;
  }
  if (resolved) {
    if (!(await persistProviderApiKey(ctx, "bifrost:default", { provider: "bifrost", resolved }))) {
      return null;
    }
    config = applyAuthProfileConfig(config, {
      profileId: "bifrost:default",
      provider: "bifrost",
      mode: "api_key",
    });
  }
  return applyProviderDefaultModel(applyBifrostModelConfig(config, model), `bifrost/${model.id}`);
}
