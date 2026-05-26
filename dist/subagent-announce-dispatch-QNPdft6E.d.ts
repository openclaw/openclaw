//#region src/agents/subagent-announce-dispatch.d.ts
type SubagentDeliveryPath = "steered" | "direct" | "none";
type SubagentAnnounceDeliveryResult = {
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  error?: string;
  phases?: SubagentAnnounceDispatchPhaseResult[];
};
type SubagentAnnounceDispatchPhase = "steer-primary" | "direct-primary" | "steer-fallback";
type SubagentAnnounceDispatchPhaseResult = {
  phase: SubagentAnnounceDispatchPhase;
  delivered: boolean;
  path: SubagentDeliveryPath;
  deliveredAt?: number;
  enqueuedAt?: number;
  error?: string;
};
//#endregion
export { SubagentAnnounceDeliveryResult as t };