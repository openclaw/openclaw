import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerCuratorCli } from "./cli.js";
import { loadUsage } from "./telemetry.js";

export default definePluginEntry({
  id: "skill-curator",
  name: "Skill Curator",
  description:
    "Tracks skill usage telemetry, auto-archives stale skills, runs LLM review passes, and snapshots workspace skills before mutations.",
  register(api: OpenClawPluginApi) {
    // Register CLI commands
    registerCuratorCli(api);

    // Register runtime lifecycle hooks
    api.registerRuntimeLifecycle({
      async activate() {
        api.logger.info("skill-curator: activated");
      },
      async deactivate() {
        api.logger.info("skill-curator: deactivated");
      },
    });

    // Hook into prompt build — the curator doesn't inject guidance, but we
    // could emit telemetry events here if the gateway prompt assembler fires them.
    api.on("before_prompt_build", async () => {
      return undefined;
    });

    // Register periodic scheduler job for curator runs
    api.registerSessionSchedulerJob({
      id: "skill-curator-periodic",
      schedule: { intervalMs: 60 * 60 * 1000 }, // hourly tick; actual gating in run logic
      async run() {
        api.logger.debug("skill-curator: periodic tick");
        // In full implementation, the gateway-side hook calls curatorRun()
        // after checking idle time. The tick here is a heartbeat for the plugin.
      },
    });
  },
});

// ── Public exports ──────────────────────────────────────────────────────────

export { loadUsage, type UsageEntry, type UsageFile } from "./telemetry.js";
export { stampAgentCreated, setCreatedBy, isAgentCreated } from "./telemetry.js";
export { determineTransition, determineAllTransitions } from "./transitions.js";
export type { TransitionThresholds, TransitionResult } from "./transitions.js";
export { createSnapshot, rotateSnapshots } from "./snapshot.js";
export type { SnapshotResult } from "./snapshot.js";
export {
  curatorRun,
  decideRun,
  pauseCurator,
  resumeCurator,
  pinSkill,
  unpinSkill,
  restoreSkill,
  adoptSkill,
  disownSkill,
} from "./run.js";
export type { CuratorConfig, RunDecision, CuratorRunResult } from "./run.js";
export { writeRunLog } from "./logs.js";
export type { RunLogEntry } from "./logs.js";
export {
  buildReviewManifest,
  parseReviewResponse,
  validatePatchAction,
  CURATOR_SYSTEM_PROMPT,
} from "./reviewer.js";
