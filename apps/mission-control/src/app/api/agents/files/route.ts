import { NextRequest, NextResponse } from "next/server";
import { getOpenClawClient } from "@/lib/openclaw-client";
import { withApiGuard, ApiGuardPresets } from "@/lib/api-guard";
import { handleApiError } from "@/lib/errors";

// GET /api/agents/files?agentId=X&name=Y — read agent file
export const GET = withApiGuard(async (request: NextRequest) => {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get("agentId");
    const name = searchParams.get("name");
    if (!agentId || !name) {
      return NextResponse.json({ error: "Missing agentId or name" }, { status: 400 });
    }
    const client = getOpenClawClient();
    await client.connect();
    const content = await client.getAgentFile(agentId, name);
    return NextResponse.json({ content });
  } catch (error) {
    return handleApiError(error, "Failed to read agent file");
  }
}, ApiGuardPresets.read);

// POST /api/agents/files — write agent file
export const POST = withApiGuard(async (request: NextRequest) => {
  try {
    const body = await request.json();
    const { agentId, name, content } = body as { agentId?: string; name?: string; content?: string };
    if (!agentId || !name || content === undefined) {
      return NextResponse.json({ error: "Missing agentId, name, or content" }, { status: 400 });
    }
    const client = getOpenClawClient();
    await client.connect();
    await client.setAgentFile(agentId, name, content);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error, "Failed to write agent file");
  }
}, ApiGuardPresets.write);
