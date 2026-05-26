import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { o as SessionEntry } from "./types-ChLEnNVH.js";
import { n as ChannelMatchSource } from "./channel-config-SOo4scvx.js";

//#region src/channels/model-overrides.d.ts
type ChannelModelOverride = {
  channel: string;
  model: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};
type ChannelModelOverrideParams = {
  cfg: OpenClawConfig;
  channel?: string | null;
  groupId?: string | null;
  groupChatType?: string | null;
  groupChannel?: string | null;
  groupSubject?: string | null;
  parentSessionKey?: string | null;
};
declare function resolveChannelModelOverride(params: ChannelModelOverrideParams): ChannelModelOverride | null;
//#endregion
//#region src/config/agent-limits.d.ts
declare function resolveAgentMaxConcurrent(cfg?: OpenClawConfig): number;
//#endregion
//#region src/sessions/model-overrides.d.ts
type ModelOverrideSelection = {
  provider: string;
  model: string;
  isDefault?: boolean;
};
declare function applyModelOverrideToSessionEntry(params: {
  entry: SessionEntry;
  selection: ModelOverrideSelection;
  profileOverride?: string;
  profileOverrideSource?: "auto" | "user";
  preserveAuthProfileOverride?: boolean;
  selectionSource?: "auto" | "user";
  markLiveSwitchPending?: boolean;
}): {
  updated: boolean;
};
//#endregion
export { resolveAgentMaxConcurrent as n, resolveChannelModelOverride as r, applyModelOverrideToSessionEntry as t };