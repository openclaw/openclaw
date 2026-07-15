/**
 * Public embedded-agent run entrypoint.
 */
import {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
} from "./run/lane-runtime.js";

export { runEmbeddedAgent } from "./run-orchestrator.js";

export const testing = {
  EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS,
  resolveEmbeddedRunLaneTimeoutMs,
};
