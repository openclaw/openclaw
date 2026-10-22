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
  skillWorkshopReviewOf?: string;
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
  if (backgroundRunKind || backgroundTrigger || provenance.skillWorkshopReviewOf) {
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
