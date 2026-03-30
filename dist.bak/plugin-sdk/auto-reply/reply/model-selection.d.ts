import { loadModelCatalog } from "../../agents/model-catalog.js";
import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
import type { ThinkLevel } from "./directives.js";
export type ModelDirectiveSelection = {
    provider: string;
    model: string;
    isDefault: boolean;
    alias?: string;
};
type ModelCatalog = Awaited<ReturnType<typeof loadModelCatalog>>;
type ModelSelectionState = {
    provider: string;
    model: string;
    allowedModelKeys: Set<string>;
    allowedModelCatalog: ModelCatalog;
    resetModelOverride: boolean;
    resolveDefaultThinkingLevel: () => Promise<ThinkLevel>;
    /** Default reasoning level from model capability: "on" if model has reasoning, else "off". */
    resolveDefaultReasoningLevel: () => Promise<"on" | "off">;
    needsModelCatalog: boolean;
};
export type StoredModelOverride = {
    provider?: string;
    model: string;
    source: "session" | "parent";
};
export declare function resolveStoredModelOverride(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    parentSessionKey?: string;
}): StoredModelOverride | null;
export declare function createModelSelectionState(params: {
    cfg: OpenClawConfig;
    agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    parentSessionKey?: string;
    storePath?: string;
    defaultProvider: string;
    defaultModel: string;
    provider: string;
    model: string;
    hasModelDirective: boolean;
    /** True when heartbeat.model was explicitly resolved for this run.
     *  In that case, skip session-stored overrides so the heartbeat selection wins. */
    hasResolvedHeartbeatModelOverride?: boolean;
}): Promise<ModelSelectionState>;
export declare function resolveModelDirectiveSelection(params: {
    raw: string;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    allowedModelKeys: Set<string>;
}): {
    selection?: ModelDirectiveSelection;
    error?: string;
};
export declare function resolveContextTokens(params: {
    agentCfg: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> | undefined;
    model: string;
}): number;
export {};
