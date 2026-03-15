import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { trackServer } from "@/lib/telemetry";
import { type WebSessionMeta, ensureDir, readIndex, writeIndex } from "./shared";
import {
  ensureManagedWorkspaceRouting,
  getActiveWorkspaceName,
  resolveActiveAgentId,
  resolveWorkspaceDirForName,
  resolveWorkspaceRoot,
} from "@/lib/workspace";
import { allocateChatAgent } from "@/lib/chat-agent-registry";

export { type WebSessionMeta };

export const dynamic = "force-dynamic";

/** GET /api/web-sessions — list web chat sessions.
 *  ?filePath=... → returns only sessions scoped to that file.
 *  No filePath   → returns only global (non-file) sessions. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const filePath = url.searchParams.get("filePath");

  const all = readIndex();
  const sessions = filePath
    ? all.filter((s) => s.filePath === filePath)
    : all.filter((s) => !s.filePath);

  return Response.json({ sessions });
}

/** POST /api/web-sessions — create a new web chat session */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const id = randomUUID();
  const now = Date.now();

  const workspaceName = getActiveWorkspaceName() ?? "default";
  const workspaceRoot = resolveWorkspaceRoot() ?? resolveWorkspaceDirForName(workspaceName);
  ensureManagedWorkspaceRouting(workspaceName, workspaceRoot, { markDefault: false });
  const workspaceAgentId = resolveActiveAgentId();

  // Assign a pool slot agent for concurrent chat support.
  // Falls back to the workspace agent if no slots are available.
  let chatAgentId: string | undefined;
  let effectiveAgentId = workspaceAgentId;
  try {
    const slot = allocateChatAgent(id);
    chatAgentId = slot.chatAgentId;
    effectiveAgentId = slot.chatAgentId;
  } catch {
    // Fall back to workspace agent
  }

  const gatewaySessionKey = `agent:${effectiveAgentId}:web:${id}`;

  const session: WebSessionMeta = {
    id,
    title: body.title || "New Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    ...(body.filePath ? { filePath: body.filePath } : {}),
    workspaceName: workspaceName || undefined,
    workspaceRoot,
    workspaceAgentId,
    chatAgentId,
    gatewaySessionKey,
    agentMode: chatAgentId ? "ephemeral" : "workspace",
    lastActiveAt: now,
  };

  const sessions = readIndex();
  sessions.unshift(session);
  writeIndex(sessions);

  const dir = ensureDir();
  writeFileSync(`${dir}/${id}.jsonl`, "");

  trackServer("session_created");

  return Response.json({ session });
}
