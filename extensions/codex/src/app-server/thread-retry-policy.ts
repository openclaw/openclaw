import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type CodexConfigReadResponse, type JsonObject } from "./protocol.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

/** Native built-ins ignore model_providers overrides, so OpenAI needs a private per-run alias. */
export async function prepareCodexNoRetryPolicy(params: {
  client: CodexAppServerClient;
  config?: JsonObject;
  effectiveConfig: CodexConfigReadResponse;
  modelProvider?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{ config: JsonObject; modelProvider: string }> {
  const config = params.config;
  const native = params.effectiveConfig.config;
  const provider =
    params.modelProvider ?? config?.model_provider ?? native.model_provider ?? "openai";
  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error("Codex cannot disable retries without a selected model provider.");
  }
  let selected = provider;
  let definition: JsonObject = {};
  if (provider === "openai") {
    const { account } = await params.client.request(
      "account/read",
      { refreshToken: false },
      {
        signal: params.signal,
        assertCurrent: params.assertCurrent,
      },
    );
    params.assertCurrent();
    selected = "openclaw-no-retry";
    // Preserve the pinned native OpenAI definition, including native account selection.
    // codex-rs/model-provider-info/src/lib.rs::create_openai_provider (0.162.1).
    definition = {
      name: "OpenAI",
      base_url:
        config?.openai_base_url ??
        native.openai_base_url ??
        (account?.type === "apiKey"
          ? "https://api.openai.com/v1"
          : "https://chatgpt.com/backend-api/codex"),
      wire_api: "responses",
      requires_openai_auth: true,
      supports_websockets: true,
      supports_standalone_web_search: true,
      include_internal_metadata: true,
      http_headers: { version: CODEX_APP_SERVER_VERSION },
      env_http_headers: {
        "OpenAI-Organization": "OPENAI_ORGANIZATION",
        "OpenAI-Project": "OPENAI_PROJECT",
      },
    };
  } else if (
    ["amazon-bedrock", "amazon-bedrock-runtime", "ollama", "lmstudio"].includes(provider)
  ) {
    throw new Error("This native built-in provider cannot enforce a no-retry background run.");
  }
  // Retain custom-provider auth, headers and endpoints; override only its two retry limits.
  const providers = isJsonObject(config?.model_providers) ? config.model_providers : {};
  const configured = providers[selected];
  const providerKey = `model_providers.${selected}`;
  const flat = config?.[providerKey];
  const retryLimits = { request_max_retries: 0, stream_max_retries: 0 };
  return {
    modelProvider: selected,
    config: {
      ...config,
      model_providers: {
        ...providers,
        [selected]: {
          ...(isJsonObject(configured) ? configured : {}),
          ...definition,
          ...retryLimits,
        },
      },
      // Preserve caller overlay shapes without leaving an older retry limit in force.
      ...(isJsonObject(flat) ? { [providerKey]: { ...flat, ...retryLimits } } : {}),
      ...Object.fromEntries(
        Object.keys(retryLimits)
          .filter((field) => config?.[`${providerKey}.${field}`] !== undefined)
          .map((field) => [`${providerKey}.${field}`, 0]),
      ),
    },
  };
}
