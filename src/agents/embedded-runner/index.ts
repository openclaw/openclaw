// Canonical directory-barrel form of the embedded runner public surface.
// Re-exports the same neutral-named symbols already published by
// `../embedded-runner.ts` (the canonical flat barrel) so callers can choose
// either import shape without behavior drift.
//
// Why a directory barrel as well as the flat barrel: third-party consumers and
// internal tooling sometimes reach for the directory shape (`embedded-runner/`)
// when scanning module ownership boundaries; the flat file alone makes that
// shape ambiguous. RFC 72072 PR 6 closes the gap.
//
// `pi-embedded-runner/index.ts` is the deprecated counterpart. It re-exports
// from the flat PI compatibility barrel so old Pi-shaped directory imports keep
// both neutral and Pi-named symbols working.

export {
  abortEmbeddedAgentRun,
  compactEmbeddedAgentSession,
  isEmbeddedAgentRunActive,
  isEmbeddedAgentRunStreaming,
  queueEmbeddedAgentMessage,
  resolveActiveEmbeddedAgentRunSessionId,
  resolveEmbeddedSessionLane,
  runEmbeddedAgent,
  waitForEmbeddedAgentRunEnd,
} from "../embedded-runner.js";
export type {
  EmbeddedAgentCompactResult,
  EmbeddedAgentMeta,
  EmbeddedAgentRunMeta,
  EmbeddedAgentRunResult,
} from "../embedded-runner.js";
