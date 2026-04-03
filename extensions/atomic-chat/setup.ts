import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { upsertAuthProfileWithLock } from "openclaw/plugin-sdk/provider-auth";
import { applyAgentDefaultModelPrimary } from "openclaw/plugin-sdk/provider-onboard";
import { discoverOpenAICompatibleLocalModels } from "openclaw/plugin-sdk/provider-setup";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  ATOMIC_CHAT_DEFAULT_API_KEY_ENV_VAR,
  ATOMIC_CHAT_DEFAULT_BASE_URL,
  ATOMIC_CHAT_PROVIDER_LABEL,
} from "./defaults.js";

const PROVIDER_ID = "atomic-chat";
const DEFAULT_API_KEY = "atomic-chat-local";

async function checkReachable(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function promptAndConfigureAtomicChat(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<{ config: OpenClawConfig }> {
  const baseUrlRaw = await params.prompter.text({
    message: "Atomic Chat base URL",
    initialValue: ATOMIC_CHAT_DEFAULT_BASE_URL,
    placeholder: ATOMIC_CHAT_DEFAULT_BASE_URL,
    validate: (value) => (value?.trim() ? undefined : "Required"),
  });
  const baseUrl = String(baseUrlRaw ?? "")
    .trim()
    .replace(/\/+$/, "");

  const reachable = await checkReachable(baseUrl);
  if (!reachable) {
    await params.prompter.note(
      [
        `Atomic Chat could not be reached at ${baseUrl}.`,
        "Make sure Atomic Chat is running and re-run setup.",
      ].join("\n"),
      "Atomic Chat",
    );
    throw new WizardCancelledError("Atomic Chat not reachable");
  }

  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    label: ATOMIC_CHAT_PROVIDER_LABEL,
  });

  if (models.length === 0) {
    await params.prompter.note(
      [
        `No models found on Atomic Chat at ${baseUrl}.`,
        "Load a model in Atomic Chat and re-run setup.",
      ].join("\n"),
      "Atomic Chat",
    );
    throw new WizardCancelledError("No Atomic Chat models available");
  }

  return {
    config: {
      ...params.cfg,
      models: {
        ...params.cfg.models,
        mode: params.cfg.models?.mode ?? "merge",
        providers: {
          ...params.cfg.models?.providers,
          [PROVIDER_ID]: {
            baseUrl,
            api: "openai-completions",
            apiKey: ATOMIC_CHAT_DEFAULT_API_KEY_ENV_VAR,
            models,
          },
        },
      },
    },
  };
}

async function storeCredential(agentDir?: string): Promise<void> {
  await upsertAuthProfileWithLock({
    profileId: `${PROVIDER_ID}:default`,
    credential: { type: "api_key", provider: PROVIDER_ID, key: DEFAULT_API_KEY },
    agentDir,
  });
}

export async function configureAtomicChatNonInteractive(params: {
  nextConfig: OpenClawConfig;
  opts: { customBaseUrl?: string; customModelId?: string };
  runtime: RuntimeEnv;
  agentDir?: string;
}): Promise<OpenClawConfig> {
  const baseUrl = (params.opts.customBaseUrl?.trim() || ATOMIC_CHAT_DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );

  const reachable = await checkReachable(baseUrl);
  if (!reachable) {
    params.runtime.error(
      [`Atomic Chat could not be reached at ${baseUrl}.`, "Make sure Atomic Chat is running."].join(
        "\n",
      ),
    );
    params.runtime.exit(1);
    return params.nextConfig;
  }

  const models = await discoverOpenAICompatibleLocalModels({
    baseUrl,
    label: ATOMIC_CHAT_PROVIDER_LABEL,
  });

  if (models.length === 0) {
    params.runtime.error(
      [
        `No models found on Atomic Chat at ${baseUrl}.`,
        "Load a model in Atomic Chat and re-run setup.",
      ].join("\n"),
    );
    params.runtime.exit(1);
    return params.nextConfig;
  }

  await storeCredential(params.agentDir);

  const defaultModelId = params.opts.customModelId?.trim() || models[0]?.id;

  const config: OpenClawConfig = {
    ...params.nextConfig,
    models: {
      ...params.nextConfig.models,
      mode: params.nextConfig.models?.mode ?? "merge",
      providers: {
        ...params.nextConfig.models?.providers,
        [PROVIDER_ID]: {
          baseUrl,
          api: "openai-completions",
          apiKey: ATOMIC_CHAT_DEFAULT_API_KEY_ENV_VAR,
          models,
        },
      },
    },
  };

  if (defaultModelId) {
    params.runtime.log(`Default Atomic Chat model: ${defaultModelId}`);
    return applyAgentDefaultModelPrimary(config, `${PROVIDER_ID}/${defaultModelId}`);
  }

  return config;
}
