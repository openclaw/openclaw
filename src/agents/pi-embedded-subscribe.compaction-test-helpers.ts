import { getSessionEntry, upsertSessionEntry } from "../config/sessions.js";

export async function seedSessionEntry(params: {
  agentId: string;
  sessionKey: string;
  compactionCount: number;
  updatedAt?: number;
}) {
  upsertSessionEntry({
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    entry: {
      sessionId: "session-1",
      updatedAt: params.updatedAt ?? 1_000,
      compactionCount: params.compactionCount,
    },
  });
}

export async function readCompactionCount(agentId: string, sessionKey: string): Promise<number> {
  return getSessionEntry({ agentId, sessionKey })?.compactionCount ?? 0;
}

export async function waitForCompactionCount(params: {
  agentId: string;
  sessionKey: string;
  expected: number;
}) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if ((await readCompactionCount(params.agentId, params.sessionKey)) === params.expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for compactionCount=${params.expected}`);
}
