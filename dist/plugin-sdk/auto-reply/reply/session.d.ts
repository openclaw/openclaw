import type { OpenClawConfig } from "../../config/config.js";
import { type GroupKeyResolution, type SessionEntry, type SessionScope } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";
export type SessionInitResult = {
    sessionCtx: TemplateContext;
    sessionEntry: SessionEntry;
    previousSessionEntry?: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    sessionKey: string;
    sessionId: string;
    isNewSession: boolean;
    resetTriggered: boolean;
    systemSent: boolean;
    abortedLastRun: boolean;
    storePath: string;
    sessionScope: SessionScope;
    groupResolution?: GroupKeyResolution;
    isGroup: boolean;
    bodyStripped?: string;
    triggerBodyNormalized: string;
};
export declare function initSessionState(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    commandAuthorized: boolean;
}): Promise<SessionInitResult>;
