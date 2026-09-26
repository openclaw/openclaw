// Vercel Ai Gateway setup module handles plugin onboarding behavior.
import { createAliasOnlyPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";

export const VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF = "vercel-ai-gateway/anthropic/claude-opus-4.6";
export const { applyConfig: applyVercelAiGatewayConfig } = createAliasOnlyPresetAppliers({
  modelRef: VERCEL_AI_GATEWAY_DEFAULT_MODEL_REF,
  alias: "Vercel AI Gateway",
});
