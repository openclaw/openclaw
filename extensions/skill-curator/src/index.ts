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

    // Register runtime lifecycle hooks for activate/deactivate
    api.registerRuntimeLifecycle({
      async activate() {
        api.logger.info("skill-curator: activated");
      },
      async deactivate() {
        api.logger.info("skill-curator: deactivated");
      },
    });

    // Hook into skill_view to increment telemetry
    api.on("before_prompt_build", async () => {
      // The curator doesn't inject prompt guidance — it's a background service.
      // Telemetry hooks will be wired when the skill tooling emits events.
      return undefined;
    });

    // Register session scheduler job for periodic curator runs
    api.registerSessionSchedulerJob({
      id: "skill-curator-periodic",
      schedule: { intervalMs: 60 * 60 * 1000 }, // placeholder — config-driven in full impl
      async run() {
        api.logger.debug("skill-curator: periodic tick");
      },
    });
  },
});

export { loadUsage } from "./telemetry.js";
export { determineTransition } from "./transitions.js";
export { createSnapshot, rotateSnapshots } from "./snapshot.js";
