import path from "path";
import fs from "fs/promises";
import { getWorkspacePath, apiResponse, apiError } from "@/lib/workspace";
import { type NextRequest } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { message, agentId } = body as { message: string; agentId?: string };

  if (!message?.trim()) {
    return apiError("Message is required", 400);
  }

  const wsPath = getWorkspacePath();
  const queuePath = path.join(wsPath, "chat-queue.jsonl");

  const entry = {
    id: crypto.randomUUID(),
    message: message.trim(),
    agentId: agentId || "jaum",
    timestamp: new Date().toISOString(),
    source: "dashboard",
  };

  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.appendFile(queuePath, JSON.stringify(entry) + "\n", "utf-8");

  return apiResponse({ queued: true, id: entry.id });
}
