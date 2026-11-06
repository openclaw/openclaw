import type {
  DecisionBatchV2,
  DecisionProviderContextV2,
  ProviderDecisionOutcomeV2,
} from "openclaw/plugin-sdk/decisions";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { encodeSageDecisionInput } from "./decision-codec.js";
import { executeSageDecision } from "./decision-execution.js";
import type { SageImageProbe } from "./sage-validation.js";

export async function evaluateLevantoDecision(
  batch: DecisionBatchV2,
  context: DecisionProviderContextV2,
  probeImage: SageImageProbe,
): Promise<ProviderDecisionOutcomeV2> {
  let encoded: ReturnType<typeof encodeSageDecisionInput>;
  try {
    encoded = encodeSageDecisionInput(batch);
  } catch {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  if (!encoded) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  return executeSageDecision(batch, {
    input: encoded,
    modelId: context.model.id,
    capabilities: context.model.inference?.decision,
    reasoning: context.reasoning,
    signal: context.signal,
    deadlineMonotonicMs: context.deadlineMonotonicMs,
    isAdmissible: context.isAdmissible,
    probeImage,
    prepareRoute: () => {
      const configuredRequest = resolveMergedModelProviderConfig(
        context.config,
        "levanto",
      )?.request;
      // The host has already resolved header/SecretRef precedence and explicit auth.
      // Only network policy is read here; never resolve or replay configured credentials.
      const networkRequest = sanitizeConfiguredModelProviderRequest({
        proxy: configuredRequest?.proxy,
        tls: configuredRequest?.tls,
        allowPrivateNetwork: configuredRequest?.allowPrivateNetwork,
      });
      return resolveProviderHttpRequestConfig({
        provider: "levanto",
        baseUrl: context.model.baseUrl,
        defaultBaseUrl: "https://sage.levanto.ai",
        api: context.model.api,
        capability: "other",
        transport: "http",
        headers: context.model.headers,
        defaultHeaders:
          configuredRequest?.auth?.mode === "header" ||
          configuredRequest?.auth?.mode === "authorization-bearer"
            ? undefined
            : { Authorization: `Bearer ${context.auth.apiKey}` },
        request: networkRequest,
      });
    },
  });
}
