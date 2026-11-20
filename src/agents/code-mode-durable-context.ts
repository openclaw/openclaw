import { AsyncLocalStorage } from "node:async_hooks";
import type { CodeModeJournal } from "../config/sessions/code-mode-journal.types.js";
import type { QueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.codec.js";
import type { ToolSearchCatalogRef } from "./tool-search-types.js";

const recovery = new AsyncLocalStorage<CodeModeJournal>();
const sources = new WeakMap<ToolSearchCatalogRef, QueuedOperatorRecoverySource>();

/** Private host context, never a model-facing argument or authority grant. */
export function withCodeModeDurableRecovery<T>(journal: CodeModeJournal, operation: () => T): T {
  return recovery.run(journal, operation);
}
export function readCodeModeDurableRecovery(): CodeModeJournal | undefined {
  return recovery.getStore();
}
export function bindCodeModeDurableSource(
  owner: ToolSearchCatalogRef,
  source: QueuedOperatorRecoverySource,
): void {
  sources.set(owner, source);
}
export function readCodeModeDurableSource(
  owner: ToolSearchCatalogRef,
): QueuedOperatorRecoverySource {
  return sources.get(owner) ?? { kind: "unavailable", reason: "no-source" };
}
