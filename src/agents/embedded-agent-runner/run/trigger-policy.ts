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
 * Returns whether this embedded run trigger should add the heartbeat prompt
 * fragment to the model input.
 */
export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    // Unlisted triggers deliberately use the default policy so new trigger
    // values are opt-in before they affect prompt bytes.
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}
