import {
  initiateComposioConnect,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} from "@/lib/composio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ConnectRequestBody = {
  toolkit?: unknown;
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

  let body: ConnectRequestBody;
  try {
    body = (await request.json()) as ConnectRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.toolkit !== "string" || !body.toolkit.trim()) {
    return Response.json(
      { error: "Field 'toolkit' must be a non-empty string." },
      { status: 400 },
    );
  }

  const origin = new URL(request.url).origin;
  const callbackUrl = `${origin}/api/composio/callback`;
  const gatewayUrl = resolveComposioGatewayUrl();

  try {
    const data = await initiateComposioConnect(
      gatewayUrl,
      apiKey,
      body.toolkit.trim(),
      callbackUrl,
    );
    return Response.json(data);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "Failed to initiate connection." },
      { status: 502 },
    );
  }
}
