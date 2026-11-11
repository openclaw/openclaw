/**
 * Embedded agent runtime barrel.
 *
 * Runtime callers import this surface for run lifecycle helpers without pulling
 * in the larger embedded-agent module path directly.
 */
export {
  abortAndDrainEmbeddedAgentRun,
  abortEmbeddedAgentRun,
  resolveActiveEmbeddedRunSessionIdBySessionFile,
  runEmbeddedAgent,
} from "./embedded-agent.js";
export { resolveActiveEmbeddedRunBySessionFile } from "./embedded-agent-runner/runs.js";
