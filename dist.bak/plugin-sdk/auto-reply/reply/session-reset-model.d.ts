import { type ModelAliasIndex } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { type ModelDirectiveSelection } from "./model-selection.js";
type ResetModelResult = {
    selection?: ModelDirectiveSelection;
    cleanedBody?: string;
};
export declare function applyResetModelOverride(params: {
    cfg: OpenClawConfig;
    resetTriggered: boolean;
    bodyStripped?: string;
    sessionCtx: TemplateContext;
    ctx: MsgContext;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
}): Promise<ResetModelResult>;
export {};
