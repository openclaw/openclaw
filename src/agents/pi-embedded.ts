/**
 * @deprecated Prefer `./embedded-runner.js` for new imports. This module is a
 * legacy Pi-named compatibility barrel for older runtime integrations.
 */
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
  EmbeddedPiAgentMeta,
  EmbeddedPiCompactResult,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "./pi-embedded-runner.js";
export {
  abortEmbeddedAgentRun,
  abortEmbeddedPiRun,
  compactEmbeddedAgentSession,
  compactEmbeddedPiSession,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunStreaming,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  queueEmbeddedAgentMessage,
  queueEmbeddedPiMessage,
  resolveActiveEmbeddedAgentRunSessionId,
  resolveActiveEmbeddedRunSessionId,
  resolveEmbeddedSessionLane,
  runEmbeddedAgent,
  runEmbeddedPiAgent,
  waitForEmbeddedAgentRunEnd,
  waitForEmbeddedPiRunEnd,
} from "./pi-embedded-runner.js";
