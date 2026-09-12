import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { loadTranscriptResolveRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

export async function resolveAgentCommandTranscript(
  params: {
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    sessionId: string;
    storePath: string;
    sessionAgentId: string;
    suppressVisibleSessionEffects: boolean;
    opts: Pick<AgentCommandOpts, "threadId">;
  },
  initialEntry?: SessionEntry,
) {
  let sessionEntry = initialEntry;
  const { resolveSessionTranscriptFile } = await loadTranscriptResolveRuntime();
  let sessionFile: string | undefined;
  if (params.sessionStore && params.sessionKey) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionStore: params.suppressVisibleSessionEffects ? undefined : params.sessionStore,
      storePath: params.suppressVisibleSessionEffects ? undefined : params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }
  if (!sessionFile) {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey ?? params.sessionId,
      storePath: params.storePath,
      sessionEntry,
      agentId: params.sessionAgentId,
      threadId: params.opts.threadId,
    });
    sessionFile = resolvedSessionFile.sessionFile;
    sessionEntry = resolvedSessionFile.sessionEntry;
  }

  return { sessionFile, sessionEntry };
}
