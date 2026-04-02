import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

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
