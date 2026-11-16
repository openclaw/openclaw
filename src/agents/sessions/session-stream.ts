import { bindStreamLlmRuntime } from "../../llm/model-runtime-binding.js";
import type { Model } from "../../llm/types.js";
import { applyLocalNoAuthHeaders } from "../model-auth-markers.js";
import { resolveProviderRequestPolicy } from "../provider-attribution.js";
import type { AgentOptions } from "../runtime/index.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import type { ModelRegistry } from "./model-registry.js";
import type { SettingsManager } from "./settings-manager.js";
import { isInstallTelemetryEnabled } from "./telemetry.js";

function getAttributionHeaders(
  model: Model,
  settingsManager: SettingsManager,
): Record<string, string> | undefined {
  // SDK-backed session streams do not all consult the attribution policy, so forward its
  // documented header set as caller headers. Hidden (spec-only) attribution stays with the
  // transports that verify it. Like the transport-side policy, this ignores install telemetry.
  const { attributionHeaders, allowsHiddenAttribution } = resolveProviderRequestPolicy({
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
  });
  if (attributionHeaders && !allowsHiddenAttribution) {
    return attributionHeaders;
  }

  if (!isInstallTelemetryEnabled(settingsManager)) {
    return undefined;
  }

  const baseUrl = model.baseUrl ?? "";

  if (
    model.provider === "cloudflare-workers-ai" ||
    model.provider === "cloudflare-ai-gateway" ||
    baseUrl.includes("api.cloudflare.com") ||
    baseUrl.includes("gateway.ai.cloudflare.com")
  ) {
    return {
      "User-Agent": "openclaw",
    };
  }

  return undefined;
}

/** Builds a registry-owned provider stream without loading session history. */
export function createSessionStreamFn(
  modelRegistry: ModelRegistry,
  settingsManager: SettingsManager,
  thinkingExplicit: boolean | undefined,
  // Optional assertion from the already-admitted caller; never an admission factory.
  assertCurrent?: () => void,
): NonNullable<AgentOptions["streamFn"]> {
  const modelRegistryRuntime = getModelRegistryRuntime(modelRegistry);
  const streamFn: NonNullable<AgentOptions["streamFn"]> = async (
    modelResult,
    context,
    optionsLocal,
  ) => {
    assertCurrent?.();
    const auth = await modelRegistry.getApiKeyAndHeaders(modelResult);
    if (!auth.ok) {
      throw new Error(auth.error);
    }
    // The admitted caller owns liveness; this stream never creates authority.
    assertCurrent?.();
    // Isolated session streams bypass the process-default stream facade.
    await import("../ai-transport-runtime-host.js");
    optionsLocal?.signal?.throwIfAborted();
    const providerRetrySettings = settingsManager.getProviderRetrySettings();
    const attributionHeaders = getAttributionHeaders(modelResult, settingsManager);
    const providerOptions = {
      ...optionsLocal,
      openclawThinkingExplicit: thinkingExplicit,
      apiKey: auth.apiKey,
      timeoutMs: optionsLocal?.timeoutMs ?? providerRetrySettings.timeoutMs,
      maxRetryDelayMs: optionsLocal?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
      headers: applyLocalNoAuthHeaders(
        modelResult.api,
        auth.apiKey,
        attributionHeaders || auth.headers || optionsLocal?.headers
          ? { ...attributionHeaders, ...auth.headers, ...optionsLocal?.headers }
          : undefined,
      ),
    };
    assertCurrent?.();
    return modelRegistryRuntime.llmRuntime.streamSimple(modelResult, context, providerOptions);
  };
  bindStreamLlmRuntime(streamFn, modelRegistryRuntime.llmRuntime);
  return streamFn;
}
