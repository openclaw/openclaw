import type {
  ProviderModelAuthPolicyContext,
  ProviderModelAuthPolicy,
} from "openclaw/plugin-sdk/provider-model-types";
import { classifyOpenAIBaseUrl } from "./base-url.js";
import {
  IDENTITY_AUTH_FLOW,
  TOKEN_SHARING_AUTH_FLOW,
  TOKEN_SHARING_RESOURCE,
} from "./token-sharing.js";

/** Credential storage mode and the endpoint it authorizes are independent. */
export function resolveModelAuthPolicy(
  ctx: ProviderModelAuthPolicyContext,
): ProviderModelAuthPolicy | undefined {
  if (ctx.provider.trim().toLowerCase() !== "openai") {
    return undefined;
  }
  const api = ctx.api?.trim().toLowerCase();
  if (ctx.mode === "oauth" && ctx.authFlow === IDENTITY_AUTH_FLOW) {
    return {
      authRequirement: null,
      compatible: false,
      incompatibilityReason:
        "requires token-sharing consent. Sign in again and enable sharing, or explicitly choose another inference credential",
    };
  }
  if (ctx.mode === "oauth" && ctx.authFlow === TOKEN_SHARING_AUTH_FLOW) {
    // The SIWC grant covers Responses inference, not the separate media APIs
    // or Codex-hosted tools. Filter before refresh/selection so a mixed store
    // can still use its independently authorized media credential.
    if (ctx.capability) {
      return {
        authRequirement: "api-key",
        compatible: false,
        incompatibilityReason:
          "does not support this operation with Sign in with ChatGPT. Configure a credential that supports it",
      };
    }
    return {
      authRequirement: "api-key",
      compatible:
        (!api || api === "openai-responses") &&
        (!ctx.baseUrl || ctx.baseUrl.replace(/\/$/, "") === TOKEN_SHARING_RESOURCE),
      incompatibilityReason:
        "requires the public OpenAI Responses endpoint for ChatGPT token sharing",
    };
  }
  const subscription = ctx.mode === "oauth" || ctx.mode === "token";
  const apiKey = ctx.mode === "api-key" || ctx.mode === "api_key";
  const codex = api === "openai-chatgpt-responses";
  // Codex OAuth can authorize embeddings; the distinct SIWC grant is rejected above.
  // Other bearer profiles require a custom embedding server's token contract.
  const requiresApiKey =
    ctx.capability === "embedding" &&
    ctx.mode !== "oauth" &&
    classifyOpenAIBaseUrl(ctx.baseUrl) !== "custom";
  return {
    authRequirement: subscription
      ? "subscription"
      : apiKey || ctx.mode === "aws-sdk"
        ? "api-key"
        : null,
    compatible:
      (!requiresApiKey || apiKey) && (api === undefined || (codex ? subscription : apiKey)),
    incompatibilityReason:
      codex && !requiresApiKey
        ? "requires a ChatGPT subscription (OAuth or token) profile"
        : "requires an OpenAI API key profile",
  };
}
