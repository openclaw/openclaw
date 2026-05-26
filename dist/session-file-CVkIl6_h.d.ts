import { o as SessionEntry, r as GroupKeyResolution, s as SessionScope } from "./types-ChLEnNVH.js";
import { m as ResolvedSessionMaintenanceConfig } from "./store-hrETKlw2.js";
import { n as MsgContext } from "./templating-DbSpLCuR.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

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
//#region src/config/sessions/transcript.d.ts
type AssistantTranscriptText = {
  id?: string;
  text: string;
  timestamp?: number;
};
type LatestAssistantTranscriptText = AssistantTranscriptText;
declare function readLatestAssistantTextFromSessionTranscript(sessionFile: string | undefined): Promise<LatestAssistantTranscriptText | undefined>;
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
export { resolveGroupSessionKey as i, readLatestAssistantTextFromSessionTranscript as n, canonicalizeMainSessionAlias as r, resolveAndPersistSessionFile as t };