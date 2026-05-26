import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { s as ReplyPayload } from "./get-reply-options.types-BalBo_kk.js";
import { o as SessionEntry } from "./types-D2DuU_TB.js";
//#region src/auto-reply/reply/commands-models.d.ts
type ModelsCommandSessionEntry = Partial<Pick<SessionEntry, "authProfileOverride" | "modelProvider" | "model">>;
type ModelsProviderData = {
  byProvider: Map<string, Set<string>>;
  providers: string[];
  resolvedDefault: {
    provider: string;
    model: string;
  };
  modelNames: Map<string, string>;
  runtimeChoicesByProvider?: Map<string, ModelsRuntimeChoice[]>;
};
type ModelsRuntimeChoice = {
  id: string;
  label: string;
  description: string;
};
declare function buildModelsProviderData(cfg: OpenClawConfig, agentId?: string, options?: {
  view?: "default" | "all";
  workspaceDir?: string;
}): Promise<ModelsProviderData>;
declare function formatModelsAvailableHeader(params: {
  provider: string;
  total: number;
  cfg: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): string;
declare function resolveModelsCommandReply(params: {
  cfg: OpenClawConfig;
  commandBodyNormalized: string;
  surface?: string;
  currentModel?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionEntry?: ModelsCommandSessionEntry;
}): Promise<ReplyPayload | null>;
//#endregion
export { resolveModelsCommandReply as i, buildModelsProviderData as n, formatModelsAvailableHeader as r, ModelsProviderData as t };