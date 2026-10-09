import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { RunEntryCandidateOptions } from "../embedded-agent-runner/run-entry.js";

export type AttemptOptions = Pick<
  RunEntryCandidateOptions,
  "isFallbackRetry" | "modelRoutingProvenance"
> &
  Partial<Omit<RunEntryCandidateOptions, "isFallbackRetry" | "modelRoutingProvenance">> & {
    resolvedThinkLevel: ThinkLevel;
    thinkingExplicit?: boolean;
  };

export function runThinkingOptions(thinkLevel: ThinkLevel, thinkingExplicit?: boolean) {
  return { thinkLevel, thinkingExplicit };
}
