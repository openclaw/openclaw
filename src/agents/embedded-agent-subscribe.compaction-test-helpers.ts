/** Seeds compaction counts in test session stores. */
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";

export async function seedSessionStore(params: {
  storePath: string;
  sessionKey: string;
  compactionCount: number;
  updatedAt?: number;
}) {
  await replaceSessionEntry({ storePath: params.storePath, sessionKey: params.sessionKey }, {
    sessionId: "session-1",
    updatedAt: params.updatedAt ?? 1_000,
    compactionCount: params.compactionCount,
  } as SessionEntry);
}
