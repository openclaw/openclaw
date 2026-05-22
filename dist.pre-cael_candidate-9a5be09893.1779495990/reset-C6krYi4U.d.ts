import { A as SessionResetConfig, E as SessionConfig } from "./types.base-DS--yneR.js";

//#region src/config/sessions/reset-policy.d.ts
type SessionResetMode = "daily" | "idle";
type SessionResetType = "direct" | "group" | "thread";
type SessionResetPolicy = {
  mode: SessionResetMode;
  atHour: number;
  idleMinutes?: number;
  configured?: boolean;
};
type SessionFreshness = {
  fresh: boolean;
  dailyResetAt?: number;
  idleExpiresAt?: number;
};
declare function resolveSessionResetPolicy(params: {
  sessionCfg?: SessionConfig;
  resetType: SessionResetType;
  resetOverride?: SessionResetConfig;
}): SessionResetPolicy;
declare function evaluateSessionFreshness(params: {
  updatedAt: number;
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  now: number;
  policy: SessionResetPolicy;
}): SessionFreshness;
//#endregion
//#region src/config/sessions/reset.d.ts
declare function resolveSessionResetType(params: {
  sessionKey?: string | null;
  isGroup?: boolean;
  isThread?: boolean;
}): SessionResetType;
declare function resolveThreadFlag(params: {
  sessionKey?: string | null;
  messageThreadId?: string | number | null;
  threadLabel?: string | null;
  threadStarterBody?: string | null;
  parentSessionKey?: string | null;
}): boolean;
declare function resolveChannelResetConfig(params: {
  sessionCfg?: SessionConfig;
  channel?: string | null;
}): SessionResetConfig | undefined;
//#endregion
export { evaluateSessionFreshness as a, SessionResetMode as i, resolveSessionResetType as n, resolveSessionResetPolicy as o, resolveThreadFlag as r, resolveChannelResetConfig as t };