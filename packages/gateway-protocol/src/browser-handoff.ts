/** Wire types shared by browser handoff clients and the Browser plugin. */
export type HumanInterventionState =
  | "waiting"
  | "control"
  | "resume_pending"
  // Stored/wire name retained: the continuation is admitted, not necessarily running.
  | "resumed"
  | "cancelled"
  | "expired";

export type HumanInterventionControlRequest = {
  id: string;
  controllerId: string;
  generation: number;
};

export type HumanInterventionView = {
  id: string;
  state: HumanInterventionState;
  generation: number;
  reason: string;
  hostname: string;
  expiresAtMs: number;
  browser: { target: "host"; profile: string; targetId: string };
};

export type HumanInterventionResponse = { handoff: HumanInterventionView };

/** Only human input is accepted; the server selects the profile and tab. */
export type HumanInterventionInput =
  | { kind: "clickCoords"; x: number; y: number; doubleClick?: boolean }
  | { kind: "dragCoords"; x: number; y: number; endX: number; endY: number }
  | { kind: "press"; key: string }
  | { kind: "type"; text: string; submit?: boolean };
