import {
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import { buildComposioToolIndex } from "@/lib/composio-tool-index";
import { resolveWorkspaceRoot } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST() {
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return Response.json(
      { error: "Dench Cloud API key is required." },
      { status: 403 },
    );
  }

  const eligibility = resolveComposioEligibility();
  if (!eligibility.eligible) {
    return Response.json(
      {
        error: "Dench Cloud must be the primary provider.",
        lockReason: eligibility.lockReason,
        lockBadge: eligibility.lockBadge,
      },
      { status: 403 },
    );
  }

  const workspaceRoot = resolveWorkspaceRoot();
  if (!workspaceRoot) {
    return Response.json(
      { error: "Workspace root not found. Set OPENCLAW_WORKSPACE or open a workspace in the UI." },
      { status: 400 },
    );
  }

  const gatewayUrl = resolveComposioGatewayUrl();

  try {
    const index = await buildComposioToolIndex({
      workspaceDir: workspaceRoot,
      gatewayUrl,
      apiKey,
    });
    return Response.json({
      ok: true,
      generated_at: index.generated_at,
      connected_apps: index.connected_apps.length,
      path: `${workspaceRoot}/composio-tool-index.json`,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to rebuild tool index." },
      { status: 502 },
    );
  }
}
