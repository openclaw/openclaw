import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

export function isAnthropicBedrockModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();

  // Direct Anthropic Claude model IDs (e.g., anthropic.claude-sonnet-4-6, global.anthropic.claude-opus-4-6-v1)
  if (normalized.includes("anthropic.claude") || normalized.includes("anthropic/claude")) {
    return true;
  }

  // Application Inference Profile ARN — detect Claude via profile ID segment only.
  // ARN format: arn:<partition>:bedrock:<region>:<account>:application-inference-profile/<id>
  // Supports all AWS partitions with Bedrock: aws, aws-cn, aws-us-gov.
  // Only the profile ID segment is trusted; user-chosen display names are too permissive
  // and could misclassify non-Anthropic models. If the profile ID doesn't contain "claude",
  // the no-cache wrapper is applied (safe default).
  if (
    /^arn:aws(-cn|-us-gov)?:bedrock:/.test(normalized) &&
    normalized.includes(":application-inference-profile/")
  ) {
    const profileId = normalized.split(":application-inference-profile/")[1] ?? "";
    return profileId.includes("claude");
  }

  // Bare Application Inference Profile names (user-chosen, passed without the ARN prefix).
  // The Bedrock API accepts bare profile names as modelId. These are alphanumeric-and-hyphen
  // strings without dots or colons, which distinguishes them from standard model IDs
  // (e.g. "amazon.nova-micro-v1:0") and system-defined profiles (e.g. "us.anthropic.claude-*").
  // Only match if the name itself contains "claude"; otherwise apply no-cache (safe default).
  if (looksLikeBareProfileName(normalized)) {
    return normalized.includes("claude");
  }

  return false;
}

/**
 * Returns true when the ID looks like a bare Application Inference Profile name
 * (alphanumeric-and-hyphen string without dots, colons, or slashes).
 * Profile names follow the pattern `([0-9a-zA-Z][ _-]?)+` (max 64 chars).
 * Examples: "my-claude-profile", "team-a-sonnet", "USClaudeSonnetIP"
 */
function looksLikeBareProfileName(normalizedId: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(normalizedId);
}
