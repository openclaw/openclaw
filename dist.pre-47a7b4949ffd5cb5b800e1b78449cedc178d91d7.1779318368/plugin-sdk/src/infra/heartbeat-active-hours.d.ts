import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];
export declare function resolveActiveHoursTimezone(cfg: OpenClawConfig, raw?: string): string;
export declare function isWithinActiveHours(cfg: OpenClawConfig, heartbeat?: HeartbeatConfig, nowMs?: number): boolean;
export {};
