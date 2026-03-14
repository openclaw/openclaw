import path from "path";
import fs from "fs/promises";
import readline from "readline";
import { createReadStream } from "fs";
import { getOpenClawPath, readJsonFile, listDirs, apiResponse, apiError } from "@/lib/workspace";
import { type NextRequest } from "next/server";

interface SessionMeta {
  sessionId: string;
  updatedAt: number;
  [key: string]: unknown;
}

interface JournalEntry {
  type: string;
  id?: string;
  timestamp?: string;
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; name?: string }>;
    timestamp?: number;
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const agentId = searchParams.get("agent") || "jaum";
  const limit = parseInt(searchParams.get("limit") || "50");
  const sessionId = searchParams.get("session");

  const ocPath = getOpenClawPath();

  // If requesting session list
  if (!sessionId) {
    const agents = await listDirs(path.join(ocPath, "agents"));
    const sessions: Array<{ sessionKey: string; agentId: string; agentName: string; sessionId: string; updatedAt: number }> = [];

    for (const aid of agents) {
      const sessionsFile = await readJsonFile<Record<string, SessionMeta>>(
        path.join(ocPath, "agents", aid, "sessions", "sessions.json")
      );
      if (!sessionsFile) continue;

      for (const [key, meta] of Object.entries(sessionsFile)) {
        sessions.push({
          sessionKey: key,
          agentId: aid,
          agentName: aid.charAt(0).toUpperCase() + aid.slice(1),
          sessionId: meta.sessionId,
          updatedAt: meta.updatedAt,
        });
      }
    }

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return apiResponse(sessions.slice(0, 50));
  }

  // Get messages from a specific session
  const jsonlPath = path.join(ocPath, "agents", agentId, "sessions", `${sessionId}.jsonl`);

  try {
    await fs.access(jsonlPath);
  } catch {
    return apiError(`Session file not found: ${agentId}/${sessionId}`, 404);
  }

  const messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    model?: string;
    type: string;
  }> = [];

  const fileStream = createReadStream(jsonlPath, { encoding: "utf-8" });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry: JournalEntry = JSON.parse(line);
      if (entry.type !== "message" || !entry.message) continue;

      const msg = entry.message;
      let content = "";

      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n");
      }

      if (!content && msg.role !== "toolResult") continue;

      messages.push({
        id: entry.id || crypto.randomUUID(),
        role: msg.role,
        content: content.slice(0, 2000),
        timestamp: entry.timestamp || new Date(msg.timestamp || 0).toISOString(),
        type: entry.type,
      });
    } catch {
      // Skip malformed lines
    }
  }

  // Return most recent messages
  const recent = messages.slice(-limit);
  return apiResponse(recent);
}
