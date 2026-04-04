import {
  disconnectComposioApp,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import { getComposioMcpHealth } from "@/lib/composio-mcp-health";
import { rebuildComposioToolIndexIfReady } from "@/lib/composio-tool-index";
import { refreshIntegrationsRuntime } from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DisconnectRequestBody = {
  connection_id?: unknown;
};

export async function POST(request: Request) {
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

  let body: DisconnectRequestBody;
  try {
    body = (await request.json()) as DisconnectRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.connection_id !== "string" || !body.connection_id.trim()) {
    return Response.json(
      { error: "Field 'connection_id' must be a non-empty string." },
      { status: 400 },
    );
  }

  const gatewayUrl = resolveComposioGatewayUrl();

  try {
    const data = await disconnectComposioApp(gatewayUrl, apiKey, body.connection_id.trim());
    const rebuild = await rebuildComposioToolIndexIfReady();
    const refresh = rebuild.ok ? await refreshIntegrationsRuntime() : undefined;
    await getComposioMcpHealth();
    return Response.json({
      ...data,
      tool_index_rebuild: rebuild.ok
        ? {
            ok: true as const,
            generated_at: rebuild.generated_at,
            connected_apps: rebuild.connected_apps,
          }
        : { ok: false as const, error: rebuild.reason },
      runtime_refresh: refresh,
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to disconnect." },
      { status: 502 },
    );
  }
}
