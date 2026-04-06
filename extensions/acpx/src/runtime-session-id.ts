import {
  AGENT_SESSION_ID_META_KEYS,
  extractAgentSessionId,
  normalizeAgentSessionId,
} from "./agent-session-id.js";

export const RUNTIME_SESSION_ID_META_KEYS = AGENT_SESSION_ID_META_KEYS;

export function normalizeRuntimeSessionId(value: unknown): string | undefined {
  return normalizeAgentSessionId(value);
}

export function extractRuntimeSessionId(meta: unknown): string | undefined {
  return extractAgentSessionId(meta);
}
