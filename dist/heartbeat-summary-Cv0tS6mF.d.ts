import { Cn as AgentDefaultsConfig, i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/infra/heartbeat-summary.d.ts
type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
type HeartbeatSummary = {
  enabled: boolean;
  every: string;
  everyMs: number | null;
  prompt: string;
  target: string;
  model?: string;
  ackMaxChars: number;
};
declare function isHeartbeatEnabledForAgent(cfg: OpenClawConfig, agentId?: string): boolean;
declare function resolveHeartbeatIntervalMs(cfg: OpenClawConfig, overrideEvery?: string, heartbeat?: HeartbeatConfig): number | null;
declare function resolveHeartbeatSummaryForAgent(cfg: OpenClawConfig, agentId?: string): HeartbeatSummary;
//#endregion
export { resolveHeartbeatSummaryForAgent as i, isHeartbeatEnabledForAgent as n, resolveHeartbeatIntervalMs as r, HeartbeatSummary as t };