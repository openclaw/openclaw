// Shared native subagent completion routing helpers.
import type { SubagentAnnounceTarget } from "./subagent-announce-target.types.js";

export function shouldAnnounceCompletionForInitialChildRun(params: {
  deliverInitialChildRunDirectly: boolean;
  announceTarget?: SubagentAnnounceTarget;
  expectsCompletionMessage: boolean;
}): boolean {
  return params.deliverInitialChildRunDirectly && params.announceTarget !== "parent"
    ? false
    : params.expectsCompletionMessage;
}
