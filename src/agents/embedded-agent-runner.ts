// Embedded-agent runner barrel. Focused submodules own run orchestration,
// compaction, queues, sandbox metadata, and SDK tool splitting.
export { compactEmbeddedAgentSession } from "./embedded-agent-runner/compact.queued.js";

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
