import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
export declare function persistInlineDirectives(params: {
    directives: InlineDirectives;
    effectiveModelDirective?: string;
    cfg: OpenClawConfig;
    agentDir?: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    elevatedEnabled: boolean;
    elevatedAllowed: boolean;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    allowedModelKeys: Set<string>;
    provider: string;
    model: string;
    initialModelLabel: string;
    formatModelSwitchEvent: (label: string, alias?: string) => string;
    agentCfg: NonNullable<OpenClawConfig["agents"]>["defaults"] | undefined;
}): Promise<{
    provider: string;
    model: string;
    contextTokens: number;
}>;
export declare function resolveDefaultModel(params: {
    cfg: OpenClawConfig;
    agentId?: string;
}): {
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
};
