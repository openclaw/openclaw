import { AsyncLocalStorage } from "node:async_hooks";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type ActivePresentation = {
  promote(entries: readonly SubagentRunRecord[], generation?: number): void;
};
const activePresentation = new AsyncLocalStorage<{ owner: ActivePresentation; runId: string }>();

/** Only a live presented successor can transfer its card through a native yield. */
export function withActiveSubagentProgressContinuation<T>(
  owner: ActivePresentation,
  runId: string,
  run: () => T,
): T {
  return activePresentation.run({ owner, runId }, run);
}

/** Native yield intent suspends edits; the committed cohort then becomes their owner. */
export function promoteSubagentProgressContinuation(
  requesterTurnRunId: string,
  entries: readonly SubagentRunRecord[],
  generation?: number,
): void {
  const active = activePresentation.getStore();
  if (active?.runId === requesterTurnRunId) {
    active.owner.promote(entries, generation);
  }
}
