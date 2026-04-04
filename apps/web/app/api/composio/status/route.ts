import { getComposioMcpHealth } from "@/lib/composio-mcp-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PostBody = {
  action?: "refresh_status" | "repair_mcp" | "probe_live_agent";
};

export async function GET() {
  try {
    const status = await getComposioMcpHealth();
    return Response.json(status);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to load Composio MCP status." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    if (!body.action || body.action === "refresh_status") {
      return Response.json(await getComposioMcpHealth());
    }
    if (body.action === "repair_mcp") {
      return Response.json(await getComposioMcpHealth({
        repairConfig: true,
        includeLiveAgentProbe: true,
      }));
    }
    if (body.action === "probe_live_agent") {
      return Response.json(await getComposioMcpHealth({ includeLiveAgentProbe: true }));
    }
    return Response.json(
      { error: "Unknown action. Use 'refresh_status', 'repair_mcp', or 'probe_live_agent'." },
      { status: 400 },
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to update Composio MCP status." },
      { status: 500 },
    );
  }
}
