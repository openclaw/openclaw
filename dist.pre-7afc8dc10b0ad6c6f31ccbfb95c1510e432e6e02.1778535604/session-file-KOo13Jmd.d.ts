import { o as SessionEntry, r as GroupKeyResolution, s as SessionScope } from "./types-BoPp7-Sf.js";
import { u as ResolvedSessionMaintenanceConfig } from "./store-CxRfAdN-.js";
import { n as MsgContext } from "./templating-DzQjcfk9.js";

//#region src/config/sessions/group.d.ts
declare function resolveGroupSessionKey(ctx: MsgContext): GroupKeyResolution | null;
//#endregion
//#region src/config/sessions/main-session.d.ts
declare function canonicalizeMainSessionAlias(params: {
  cfg?: {
    session?: {
      scope?: SessionScope;
      mainKey?: string;
    };
  };
  agentId: string;
  sessionKey: string;
}): string;
//#endregion
//#region src/config/sessions/session-file.d.ts
declare function resolveAndPersistSessionFile(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  sessionEntry?: SessionEntry;
  agentId?: string;
  sessionsDir?: string;
  fallbackSessionFile?: string;
  activeSessionKey?: string;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
}): Promise<{
  sessionFile: string;
  sessionEntry: SessionEntry;
}>;
//#endregion
export { canonicalizeMainSessionAlias as n, resolveGroupSessionKey as r, resolveAndPersistSessionFile as t };