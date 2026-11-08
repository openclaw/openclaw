// Embedded-agent runner barrel. Focused submodules own run orchestration,
// compaction, queues, sandbox metadata, and SDK tool splitting.
export const compactEmbeddedAgentSession: typeof import("./embedded-agent-runner/compact.queued.js").compactEmbeddedAgentSession =
  async (params, options) => {
    const { compactEmbeddedAgentSession: compact } =
      await import("./embedded-agent-runner/compact.queued.js");
    return compact(params, options);
  };

export { runEmbeddedAgent } from "./embedded-agent-runner/run.js";
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
} from "./embedded-agent-runner/runs.js";
export type {
  EmbeddedAgentMeta,
  EmbeddedAgentCompactResult,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "./embedded-agent-runner/types.js";
