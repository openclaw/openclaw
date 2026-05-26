import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { o as SessionEntry } from "../types-ChLEnNVH.js";

//#region src/sessions/classify-session-kind.d.ts
type SessionKind = "cron" | "direct" | "group" | "global" | "spawn-child" | "unknown";
/**
 * Classify a session key + entry into a display kind.
 *
 * Evaluation order matters — more-specific signals take priority:
 *   1. sentinel keys ("global", "unknown")
 *   2. cron key shape
 *   3. spawn-child (entry has `spawnedBy`) — checked before key-shape so ACP
 *      spawn-child sessions with opaque keys are not misclassified as "direct"
 *   4. group/channel chatType or key-shape substring
 *   5. fallback: "direct"
 */
declare function classifySessionKind(key: string, entry?: {
  chatType?: string | null;
  spawnedBy?: string | null;
}): SessionKind;
//#endregion
//#region src/commands/status.summary.runtime.d.ts
declare function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): {
  provider: string;
  model: string;
};
declare function resolveSessionModelRef(cfg: OpenClawConfig, entry?: SessionEntry | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">, agentId?: string): {
  provider: string;
  model: string;
};
declare function resolveSessionRuntimeLabel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  provider: string;
  model: string;
  agentId?: string;
  sessionKey: string;
}): string;
declare function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
  allowAsyncLoad?: boolean;
}): number | undefined;
declare const statusSummaryRuntime: {
  resolveContextTokensForModel: typeof resolveContextTokensForModel;
  classifySessionKey: typeof classifySessionKind;
  resolveSessionModelRef: typeof resolveSessionModelRef;
  resolveSessionRuntimeLabel: typeof resolveSessionRuntimeLabel;
  resolveConfiguredStatusModelRef: typeof resolveConfiguredStatusModelRef;
};
//#endregion
export { statusSummaryRuntime };