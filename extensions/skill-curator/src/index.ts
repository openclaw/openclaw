import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerCuratorCli } from "./cli.js";
import { resolveConfig } from "./config.js";
import { curatorRun } from "./run.js";

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

    // Hook: after every agent turn ends, check if curator should run.
    // This covers the trigger logic without needing a separate scheduler.
    api.on("agent_end", async (_event, ctx) => {
      try {
        const workspaceDir = ctx.workspaceDir ?? path.join(os.homedir(), ".openclaw", "workspace");

        const config = resolveConfig(api.pluginConfig);
        const result = await curatorRun({ workspaceDir, config, dryRun: false });

        if (result.mutations.length > 0) {
          api.logger.info(
            `skill-curator: applied ${result.mutations.length} mutation(s) — ${result.mutations.map((m) => m.name).join(", ")}`,
          );
        }
        if (
          result.error &&
          !result.error.includes("first-run") &&
          !result.error.includes("paused")
        ) {
          api.logger.warn(`skill-curator: ${result.error}`);
        }
      } catch (err) {
        // Non-critical — never fail the agent turn over curator issues
        api.logger.debug(
          `skill-curator: agent_end hook skipped — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
  curatorRunReview,
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
