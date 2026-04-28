import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

// FORK: default-agent non-cron/non-heartbeat runs SHOULD inject the heartbeat
// prompt (e.g. user-driven turns on the heartbeat agent). Heartbeat- and
// cron-triggered runs explicitly suppress it so exec/cron wakes don't
// re-execute the heartbeat checklist on every event.
const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY: EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: true,
};

const EMBEDDED_RUN_TRIGGER_POLICY: Partial<Record<EmbeddedRunTrigger, EmbeddedRunTriggerPolicy>> = {
  cron: {
    injectHeartbeatPrompt: false,
  },
  // FORK: exec completion wakes should not inject the heartbeat prompt.
  // Without this, exec:*:exit events on non-main sessions cause the agent
  // to read HEARTBEAT.md and run the full heartbeat checklist.
  heartbeat: {
    injectHeartbeatPrompt: false,
  },
};

export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}
