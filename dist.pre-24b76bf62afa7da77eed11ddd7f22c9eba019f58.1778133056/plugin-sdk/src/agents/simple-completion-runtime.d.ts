import { complete, type Api, type Model } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type ResolvedProviderAuth } from "./model-auth.js";
type AllowedMissingApiKeyMode = ResolvedProviderAuth["mode"];
export type SimpleCompletionModelOptions = {
    maxTokens?: number;
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
    skipPiDiscovery?: boolean;
}): Promise<PreparedSimpleCompletionModel>;
export declare function prepareSimpleCompletionModelForAgent(params: {
    cfg: OpenClawConfig;
    agentId: string;
    modelRef?: string;
    preferredProfile?: string;
    allowMissingApiKeyModes?: ReadonlyArray<AllowedMissingApiKeyMode>;
    skipPiDiscovery?: boolean;
}): Promise<PreparedSimpleCompletionModelForAgent>;
export declare function completeWithPreparedSimpleCompletionModel(params: {
    model: Model<Api>;
    auth: ResolvedProviderAuth;
    context: Parameters<typeof complete>[1];
    cfg?: OpenClawConfig;
    options?: SimpleCompletionModelOptions;
}): Promise<import("@mariozechner/pi-ai").AssistantMessage>;
export {};
