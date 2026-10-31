import type { DecisionProviderV2 } from "openclaw/plugin-sdk/decisions";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth-api-key";
import { resolveMergedModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
} from "openclaw/plugin-sdk/provider-http";
import { encodeSageDecisionInput } from "./decision-codec.js";
import { executeSageDecision } from "./decision-execution.js";
import type { SageImageProbe } from "./sage-validation.js";

export default definePluginEntry({
  id: "levanto",
  name: "Levanto Sage",
  description: "Native typed decisions with explicit abstention.",
  register(api) {
    const probeImage: SageImageProbe = (bytes) => api.runtime.media.getImageMetadata(bytes);
    const provider: DecisionProviderV2 = {
      id: "levanto",
      contractVersion: 2,
      async evaluate(batch, context) {
        context.signal.throwIfAborted();
        if (
          context.model.provider !== "levanto" ||
          context.model.id !== "levanto-sage" ||
          context.model.api !== undefined
        ) {
          return { status: "unavailable", reason: "unsupported-input" };
        }
        if (!context.auth.apiKey) {
          // Effective headers never provide a second credential-discovery route.
          return { status: "unavailable", reason: "credentials-unavailable" };
        }
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
      },
    };

    api.registerDecisionProvider({
      ...provider,
      provider: {
        label: "Levanto Sage",
        docsPath: "/providers/levanto",
        authScope: "agent",
        envVars: ["LEVANTO_API_KEY"],
        auth: [
          createProviderApiKeyAuthMethod({
            providerId: "levanto",
            methodId: "api-key",
            label: "Levanto API key",
            optionKey: "levantoApiKey",
            flagName: "--levanto-api-key",
            envVar: "LEVANTO_API_KEY",
            promptMessage: "Enter your Levanto API key",
            // Connecting credentials never changes a conversational or decision model selection.
            wizard: {
              choiceId: "levanto-api-key",
              choiceLabel: "Levanto API key",
              groupId: "levanto",
              groupLabel: "Levanto Sage",
              modelTarget: "utility",
            },
          }),
        ],
      },
    });
  },
});
