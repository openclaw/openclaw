import { OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH } from "@openclaw/ai/providers";
import { truncateCodePoints } from "@openclaw/normalization-core/code-points";
import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { normalizeAgentId } from "../../../routing/session-key.js";

export function resolveWebchatPromptCacheKey(params: {
  agentId: string;
  model: string;
  provider: string;
  sessionKey: string;
}): string {
  const digest = sha256HexPrefixCore(
    [
      "v1",
      params.provider.trim().toLowerCase(),
      params.model.trim(),
      normalizeAgentId(params.agentId),
      params.sessionKey,
    ].join("\0"),
    32,
  );
  return `openclaw-webchat-${digest}`;
}

export function resolveSessionBoundaryPromptCacheKey(params: {
  api: string;
  boundaryCount: number;
  promptCacheKey?: string;
  sessionId: string;
}): string | undefined {
  const explicit = params.promptCacheKey?.trim();
  if (explicit) {
    return explicit;
  }
  if (!params.api.includes("openai")) {
    return undefined;
  }
  // Reserve the lifecycle suffix inside OpenAI's 64-code-point limit for proxy runtimes.
  const suffix = `:${params.boundaryCount}`;
  const maxSessionIdLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - suffix.length;
  return `${truncateCodePoints(params.sessionId, maxSessionIdLength)}${suffix}`;
}
