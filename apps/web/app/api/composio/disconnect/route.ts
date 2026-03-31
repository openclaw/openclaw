import {
  disconnectComposioApp,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";

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
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to disconnect." },
      { status: 502 },
    );
  }
}
