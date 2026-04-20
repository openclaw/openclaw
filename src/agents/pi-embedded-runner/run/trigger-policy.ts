import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

// The heartbeat system prompt tells the model to reply exactly "HEARTBEAT_OK"
// when nothing needs attention. It is only meaningful on heartbeat-triggered
// runs; injecting it on user/manual/memory/overflow runs confuses smaller
// models into pattern-matching the HEARTBEAT_OK output on real user messages
// (delivery then suppresses the "reply", so the user sees silence) or into
// fabricating "[object Object]" serialization errors as they try to reconcile
// the heartbeat instruction with a non-heartbeat turn. See issue #69079 and
// its parent #50797. Default off; heartbeat trigger explicitly opts in.
const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY: EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: false,
};

const EMBEDDED_RUN_TRIGGER_POLICY: Partial<Record<EmbeddedRunTrigger, EmbeddedRunTriggerPolicy>> = {
  heartbeat: {
    injectHeartbeatPrompt: true,
  },
};

export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}
