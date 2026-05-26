import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/channels/inbound-event/kind.d.ts
type InboundEventKind = "user_request" | "room_event";
//#endregion
//#region src/sessions/input-provenance.d.ts
declare const INPUT_PROVENANCE_KIND_VALUES: readonly ["external_user", "inter_session", "internal_system"];
type InputProvenanceKind = (typeof INPUT_PROVENANCE_KIND_VALUES)[number];
type InputProvenance = {
  kind: InputProvenanceKind;
  originSessionId?: string;
  sourceSessionKey?: string;
  sourceChannel?: string;
  sourceTool?: string;
};
//#endregion
export { InboundEventKind as n, InputProvenance as t };