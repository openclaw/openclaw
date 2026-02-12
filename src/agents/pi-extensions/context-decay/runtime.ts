import type { ContextDecayConfig } from "../../../config/types.agent-defaults.js";
import type { GroupSummaryStore, SummaryStore } from "../../context-decay/summary-store.js";

/** Per-session runtime state for the context-decay extension. */
export type ContextDecayRuntimeValue = {
  config: ContextDecayConfig;
  summaryStore: SummaryStore;
  groupSummaryStore: GroupSummaryStore;
};

const REGISTRY = new WeakMap<object, ContextDecayRuntimeValue>();

/** Register context-decay config + summary store for a session. Pass null to clear. */
export function setContextDecayRuntime(
  sessionManager: unknown,
  value: ContextDecayRuntimeValue | null,
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

/** Retrieve the context-decay runtime for a session, or null if not registered. */
export function getContextDecayRuntime(sessionManager: unknown): ContextDecayRuntimeValue | null {
  if (!sessionManager || typeof sessionManager !== "object") {
    return null;
  }
  return REGISTRY.get(sessionManager) ?? null;
}
