import { completeSimple, type Api, type Model, type ThinkingLevel as SimpleCompletionThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolvedProviderAuth } from "./model-auth.js";
import { resolveModelAsync } from "./pi-embedded-runner/model.js";
type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];
export type SimpleCompletionModelOptions = {
    maxTokens?: number;
    temperature?: number;
    reasoning?: ThinkLevel | SimpleCompletionThinkingLevel;
    signal?: AbortSignal;
};
export type PreparedSimpleCompletionModel = {
    model: Model<Api>;
    auth: ResolvedProviderAuth;
} | {
    error: string;
    auth?: ResolvedProviderAuth;
};
export type AgentSimpleCompletionSelection = {
    provider: string;
    modelId: string;
    /** Provider used for auth/transport when runtime policy redirects the logical model ref. */
    runtimeProvider?: string;
    profileId?: string;
    agentDir: string;
};
export type PreparedSimpleCompletionModelForAgent = {
    selection: AgentSimpleCompletionSelection;
    model: Model<Api>;
    auth: ResolvedProviderAuth;
} | {
    error: string;
    selection?: AgentSimpleCompletionSelection;
    auth?: ResolvedProviderAuth;
};
export declare function resolveSimpleCompletionSelectionForAgent(params: {
    cfg: OpenClawConfig;
    agentId: string;
    modelRef?: string;
}): AgentSimpleCompletionSelection | null;
export declare function prepareSimpleCompletionModel(params: {
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
export declare function prepareSimpleCompletionModelForAgent(params: {
    cfg: OpenClawConfig;
    agentId: string;
    modelRef?: string;
    preferredProfile?: string;
    allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
    allowBundledStaticCatalogFallback?: boolean;
    skipPiDiscovery?: boolean;
    modelResolver?: typeof resolveModelAsync;
}): Promise<PreparedSimpleCompletionModelForAgent>;
export declare function completeWithPreparedSimpleCompletionModel(params: {
    model: Model<Api>;
    auth: ResolvedProviderAuth;
    context: Parameters<typeof completeSimple>[1];
    cfg?: OpenClawConfig;
    options?: SimpleCompletionModelOptions;
}): Promise<import("@earendil-works/pi-ai").AssistantMessage>;
export {};
