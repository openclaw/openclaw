import { i as OpenClawConfig } from "../types.openclaw-DIZy8jcb.js";
import { o as SessionEntry } from "../types-D2DuU_TB.js";

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
declare function classifySessionKey(key: string, entry?: SessionEntry): "global" | "unknown" | "cron" | "group" | "direct";
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
  classifySessionKey: typeof classifySessionKey;
  resolveSessionModelRef: typeof resolveSessionModelRef;
  resolveSessionRuntimeLabel: typeof resolveSessionRuntimeLabel;
  resolveConfiguredStatusModelRef: typeof resolveConfiguredStatusModelRef;
};
//#endregion
export { statusSummaryRuntime };