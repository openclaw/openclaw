import { resolveComposioEligibility } from "@/lib/composio";
import { getComposioMcpHealth } from "@/lib/composio-mcp-health";
import { rebuildComposioToolIndexIfReady } from "@/lib/composio-tool-index";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorStatus(reason: string): number {
  if (reason === "Dench Cloud API key is required.") {
    return 403;
  }
  if (reason === "Dench Cloud must be the primary provider.") {
    return 403;
  }
  if (reason.startsWith("Workspace root not found")) {
    return 400;
  }
  return 502;
}

export async function POST() {
  const result = await rebuildComposioToolIndexIfReady();
  if (!result.ok) {
    const body: Record<string, unknown> = { error: result.reason };
    if (result.reason === "Dench Cloud must be the primary provider.") {
      const eligibility = resolveComposioEligibility();
      body.lockReason = eligibility.lockReason;
      body.lockBadge = eligibility.lockBadge;
    }
    return Response.json(body, { status: errorStatus(result.reason) });
  }

  await getComposioMcpHealth();

  return Response.json({
    ok: true,
    generated_at: result.generated_at,
    connected_apps: result.connected_apps,
    path: `${result.workspaceDir}/composio-tool-index.json`,
  });
}
