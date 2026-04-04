import {
  type DenchIntegrationId,
  normalizeLockedDenchIntegrations,
  refreshIntegrationsRuntime,
  setApolloIntegrationEnabled,
  setElevenLabsIntegrationEnabled,
  setExaIntegrationEnabled,
} from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ToggleRequestBody = {
  enabled?: unknown;
};

function isSupportedIntegration(id: string): id is DenchIntegrationId {
  return id === "exa" || id === "apollo" || id === "elevenlabs";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isSupportedIntegration(id)) {
    return Response.json({ error: "Unknown integration." }, { status: 404 });
  }

  let body: ToggleRequestBody;
  try {
    body = (await request.json()) as ToggleRequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (typeof body.enabled !== "boolean") {
    return Response.json({ error: "Field 'enabled' must be a boolean." }, { status: 400 });
  }

  const normalized = normalizeLockedDenchIntegrations();
  const target = normalized.state.integrations.find((integration) => integration.id === id);
  if (body.enabled && target?.locked) {
    const refresh = normalized.changed
      ? await refreshIntegrationsRuntime()
      : {
        attempted: false,
        restarted: false,
        error: null,
        profile: "default",
      };
    return Response.json({
      error: target.lockReason === "missing_dench_key"
        ? "This integration requires a Dench Cloud API key."
        : "This integration requires Dench Cloud to be the primary provider.",
      integration: id,
      changed: normalized.changed,
      refresh,
      ...normalized.state,
    }, { status: 409 });
  }

  let result;
  switch (id) {
    case "exa": {
      result = setExaIntegrationEnabled(body.enabled);
      break;
    }
    case "apollo": {
      result = setApolloIntegrationEnabled(body.enabled);
      break;
    }
    case "elevenlabs": {
      result = setElevenLabsIntegrationEnabled(body.enabled);
      break;
    }
    default:
      return Response.json({ error: `Integration '${id}' is not writable yet.` }, { status: 409 });
  }

  if (result.error) {
    return Response.json({
      error: result.error,
      integration: id,
      changed: result.changed,
      refresh: {
        attempted: false,
        restarted: false,
        error: null,
        profile: "default",
      },
      ...result.state,
    }, { status: 409 });
  }

  const refresh = result.changed
    ? await refreshIntegrationsRuntime()
    : {
      attempted: false,
      restarted: false,
      error: null,
      profile: "default",
    };

  return Response.json({
    integration: id,
    changed: result.changed,
    refresh,
    ...result.state,
  });
}
