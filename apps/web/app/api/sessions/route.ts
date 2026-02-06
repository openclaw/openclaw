import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const dynamic = "force-dynamic";

type SessionEntry = {
  sessionId: string;
  updatedAt: number;
  label?: string;
  displayName?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  compactionCount?: number;
};

type SessionRow = {
  key: string;
  sessionId: string;
  updatedAt: number;
  label?: string;
  displayName?: string;
  channel?: string;
  model?: string;
  modelProvider?: string;
  thinkingLevel?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
};

function resolveOpenClawDir(): string {
  return join(homedir(), ".openclaw");
}

export async function GET() {
  const openclawDir = resolveOpenClawDir();
  const agentsDir = join(openclawDir, "agents");

  if (!existsSync(agentsDir)) {
    return Response.json({ agents: [], sessions: [] });
  }

  const allSessions: SessionRow[] = [];
  const agentIds: string[] = [];

  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      agentIds.push(entry.name);

      const storePath = join(agentsDir, entry.name, "sessions", "sessions.json");
      if (!existsSync(storePath)) continue;

      try {
        const raw = readFileSync(storePath, "utf-8");
        const store = JSON.parse(raw) as Record<string, SessionEntry>;
        for (const [key, session] of Object.entries(store)) {
          if (!session || typeof session !== "object") continue;
          allSessions.push({
            key,
            sessionId: session.sessionId,
            updatedAt: session.updatedAt,
            label: session.label,
            displayName: session.displayName,
            channel: session.channel,
            model: session.model,
            modelProvider: session.modelProvider,
            thinkingLevel: session.thinkingLevel,
            inputTokens: session.inputTokens,
            outputTokens: session.outputTokens,
            totalTokens: session.totalTokens,
            contextTokens: session.contextTokens,
          });
        }
      } catch {
        // skip unreadable store files
      }
    }
  } catch {
    // agents dir unreadable
  }

  // Sort by updatedAt descending
  allSessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  return Response.json({ agents: agentIds, sessions: allSessions });
}
