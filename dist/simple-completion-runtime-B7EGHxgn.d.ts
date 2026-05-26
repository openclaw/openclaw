import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as ThinkLevel } from "./thinking.shared-DZFlsfdo.js";
import { b as ResolvedProviderAuth } from "./types-core-DxqEkbXr.js";
import { t as resolveModelAsync } from "./model-BhzuYXOU.js";
import { Api, Model, ThinkingLevel, completeSimple } from "@earendil-works/pi-ai";

//#region src/agents/simple-completion-runtime.d.ts
type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];
type SimpleCompletionModelOptions = {
  maxTokens?: number;
  temperature?: number;
  reasoning?: ThinkLevel | ThinkingLevel;
  signal?: AbortSignal;
};
type PreparedSimpleCompletionModel = {
  model: Model<Api>;
  auth: ResolvedProviderAuth;
} | {
  error: string;
  auth?: ResolvedProviderAuth;
};
type AgentSimpleCompletionSelection = {
  provider: string;
  modelId: string; /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
  runtimeProvider?: string;
  profileId?: string;
  agentDir: string;
};
type PreparedSimpleCompletionModelForAgent = {
  selection: AgentSimpleCompletionSelection;
  model: Model<Api>;
  auth: ResolvedProviderAuth;
} | {
  error: string;
  selection?: AgentSimpleCompletionSelection;
  auth?: ResolvedProviderAuth;
};
declare function resolveSimpleCompletionSelectionForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
}): AgentSimpleCompletionSelection | null;
declare function prepareSimpleCompletionModel(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  modelId: string;
  agentDir?: string;
  profileId?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  skipPiDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModel>;
declare function prepareSimpleCompletionModelForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  preferredProfile?: string;
  allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
  allowBundledStaticCatalogFallback?: boolean;
  skipPiDiscovery?: boolean;
  modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent>;
declare function completeWithPreparedSimpleCompletionModel(params: {
  model: Model<Api>;
  auth: ResolvedProviderAuth;
  context: Parameters<typeof completeSimple>[1];
  cfg?: OpenClawConfig;
  options?: SimpleCompletionModelOptions;
}): Promise<import("@earendil-works/pi-ai").AssistantMessage>;
//#endregion
export { completeWithPreparedSimpleCompletionModel as a, resolveSimpleCompletionSelectionForAgent as c, SimpleCompletionModelOptions as i, PreparedSimpleCompletionModel as n, prepareSimpleCompletionModel as o, PreparedSimpleCompletionModelForAgent as r, prepareSimpleCompletionModelForAgent as s, AgentSimpleCompletionSelection as t };