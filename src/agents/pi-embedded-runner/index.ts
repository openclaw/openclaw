// Deprecated directory-barrel form of the embedded runner public surface.
// Existed only as a `pi-embedded-runner` historical name. New code must import
// from the neutral `embedded-runner` barrel (`../embedded-runner.js` for the
// flat shape or `../embedded-runner/index.js` for the directory shape).
//
// Both Pi-named and neutral-named symbols are re-exported here so old
// `pi-embedded-runner/index.js` imports keep working. The Pi-named
// `runEmbeddedPiAgent`, `compactEmbeddedPiSession`, etc. continue to work via
// the existing flat-file barrel `../pi-embedded-runner.ts`.
//
// @deprecated Prefer `../embedded-runner/index.js` for new imports; this
// directory barrel exists only for backward compatibility per RFC 72072 PR 6.

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
} from "../pi-embedded-runner.js";
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
  EmbeddedPiAgentMeta,
  EmbeddedPiCompactResult,
  EmbeddedPiRunMeta,
  EmbeddedPiRunResult,
} from "../pi-embedded-runner.js";
