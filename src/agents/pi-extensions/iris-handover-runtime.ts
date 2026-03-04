import type { AgentHandoverConfig } from "../../config/types.agent-defaults.js";

export type HandoverRuntimeValue = {
  contextWindowTokens?: number;
  maxHistoryShare?: number;
  handoverConfig?: AgentHandoverConfig;
  workspace?: string;
};

// Session-scoped runtime registry keyed by object identity.
// Same WeakMap pattern as compaction-safeguard-runtime.ts.
const REGISTRY = new WeakMap<object, HandoverRuntimeValue>();

export function setHandoverRuntime(
  sessionManager: unknown,
  value: HandoverRuntimeValue | null,
): void {
  if (!sessionManager || typeof sessionManager !== "object") {
    return;
  }
  const key = sessionManager;
  if (value === null) {
    REGISTRY.delete(key);
    return;
  }
  REGISTRY.set(key, value);
}

export function getHandoverRuntime(sessionManager: unknown): HandoverRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return REGISTRY.get(sessionManager) ?? null;
}
