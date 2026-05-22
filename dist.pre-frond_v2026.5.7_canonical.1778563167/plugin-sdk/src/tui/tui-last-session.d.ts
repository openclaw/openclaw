import type { TuiSessionList } from "./tui-backend.js";
import type { SessionScope } from "./tui-types.js";
export declare function resolveTuiLastSessionStatePath(stateDir?: string): string;
export declare function buildTuiLastSessionScopeKey(params: {
    connectionUrl: string;
    agentId: string;
    sessionScope: SessionScope;
}): string;
export declare function isHeartbeatLikeTuiSession(session: TuiSessionList["sessions"][number]): boolean;
export declare function readTuiLastSessionKey(params: {
    scopeKey: string;
    stateDir?: string;
}): Promise<string | null>;
export declare function writeTuiLastSessionKey(params: {
    scopeKey: string;
    sessionKey: string;
    stateDir?: string;
}): Promise<void>;
export declare function resolveRememberedTuiSessionKey(params: {
    rememberedKey: string | null | undefined;
    currentAgentId: string;
    sessions: TuiSessionList["sessions"];
}): string | null;
