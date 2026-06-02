import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY: EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: false,
};

const EMBEDDED_RUN_TRIGGER_POLICY: Partial<Record<EmbeddedRunTrigger, EmbeddedRunTriggerPolicy>> = {
  heartbeat: {
    injectHeartbeatPrompt: true,
  },
};

/**
 * Returns true when the trigger needs the heartbeat-specific prompt prefix.
 * Unknown or omitted triggers use the default policy so new trigger names do
 * not accidentally inherit heartbeat behavior.
 */
export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}
