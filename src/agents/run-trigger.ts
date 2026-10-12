import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { BootstrapContextRunKind } from "./bootstrap-mode.js";
import type { TrustedSubagentCompletionHandoff } from "./subagents/announce/subagent-announce-handoff.js";

export type EmbeddedRunTrigger =
  | "cron"
  | "event"
  | "heartbeat"
  | "manual"
  | "memory"
  | "overflow"
  | "user";

export type ModelCallUrgency = "foreground" | "normal" | "background";

export function resolveModelCallUrgency(provenance: {
  trigger?: EmbeddedRunTrigger;
  bootstrapContextRunKind?: BootstrapContextRunKind;
  currentInboundEventKind?: InboundEventKind;
  inputProvenance?: InputProvenance;
  spawnedBy?: string | null;
  trustedInternalHandoff?: boolean | TrustedSubagentCompletionHandoff;
}): ModelCallUrgency {
  const backgroundRunKind =
    provenance.bootstrapContextRunKind === "cron" ||
    provenance.bootstrapContextRunKind === "heartbeat";
  const backgroundTrigger =
    provenance.trigger === "cron" ||
    provenance.trigger === "heartbeat" ||
    provenance.trigger === "memory";
  if (backgroundRunKind || backgroundTrigger) {
    return "background";
  }
  // Delegated runs may retain user provenance; they are not the interactive source turn.
  if (
    provenance.spawnedBy ||
    Boolean(provenance.trustedInternalHandoff) ||
    provenance.inputProvenance?.kind === "inter_session" ||
    provenance.inputProvenance?.kind === "internal_system"
  ) {
    return "normal";
  }
  if (
    provenance.currentInboundEventKind === "user_request" ||
    provenance.inputProvenance?.kind === "external_user" ||
    provenance.trigger === "user"
  ) {
    return "foreground";
  }
  return "normal";
}

/** Bounded internal diagnostic labels, independent of execution policy triggers. */
export type IsolatedCompletionPurpose =
  | "isolated-completion"
  | "session-activity-summary"
  | "session-observer"
  | "conversation-label"
  | "progress-narration"
  | "transcript-summary"
  | "plugin-completion";
