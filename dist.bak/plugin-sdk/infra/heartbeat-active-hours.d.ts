import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
export declare function isWithinActiveHours(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig, nowMs?: number): boolean;
export {};
