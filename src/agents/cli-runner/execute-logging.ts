import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { PreparedCliRunContext } from "./types.js";
export const CLAUDE_SELECTED_AUTH_ENV_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
export const NODE_CLAUDE_FORWARD_ENV_KEYS = new Set([
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  // Re-injected per run from OpenClaw's effective thinking level. Without these
  // the paired node falls back to Claude Code's own effort resolution, so
  // `/think off` would silently revert on the node host.
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "MAX_THINKING_TOKENS",
]);
export function resolveNodeClaudeAuthEnv(context: PreparedCliRunContext): Record<string, string> {
  const secretInput = context.preparedBackend.secretInput;
  if (!secretInput) {
    return {};
  }
  const descriptorEnv = context.preparedBackend.env ?? {};
  const requestEnv = Object.hasOwn(descriptorEnv, "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
    ? "CLAUDE_CODE_OAUTH_TOKEN"
    : Object.hasOwn(descriptorEnv, "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR")
      ? "ANTHROPIC_API_KEY"
      : undefined;
  if (!requestEnv) {
    return {};
  }
  const data = secretInput.createData();
  try {
    return { [requestEnv]: data.toString("utf8") };
  } finally {
    data.fill(0);
  }
}
export const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
export function parseCliBackendPreserveEnv(raw: string | undefined): Set<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set();
  }
  if (trimmed.startsWith("[")) {
    try {
      return new Set(filterStringEntries(JSON.parse(trimmed)));
    } catch {
      return new Set();
    }
  }
  return new Set(trimmed.split(/[,\s]+/).filter(Boolean));
}
