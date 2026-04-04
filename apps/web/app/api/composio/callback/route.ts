import {
  fetchComposioConnections,
  resolveComposioApiKey,
  resolveComposioGatewayUrl,
} from "@/lib/composio";
import {
  extractComposioConnections,
  normalizeComposioConnections,
} from "@/lib/composio-client";
import { rebuildComposioToolIndexIfReady } from "@/lib/composio-tool-index";
import { getComposioMcpHealth } from "@/lib/composio-mcp-health";
import { refreshIntegrationsRuntime } from "@/lib/integrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function resolveConnectedToolkitSummary(connectedAccountId: string): Promise<{
  toolkit_slug: string | null;
  toolkit_name: string | null;
  status: string | null;
}> {
  if (!connectedAccountId) {
    return {
      toolkit_slug: null,
      toolkit_name: null,
      status: null,
    };
  }

  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return {
      toolkit_slug: null,
      toolkit_name: null,
      status: null,
    };
  }

  try {
    const connections = normalizeComposioConnections(
      extractComposioConnections(
        await fetchComposioConnections(resolveComposioGatewayUrl(), apiKey),
      ),
    );
    const match = connections.find((connection) => connection.id === connectedAccountId);
    return {
      toolkit_slug: match?.normalized_toolkit_slug ?? null,
      toolkit_name: match?.toolkit_name ?? null,
      status: match?.normalized_status ?? null,
    };
  } catch {
    return {
      toolkit_slug: null,
      toolkit_name: null,
      status: null,
    };
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { searchParams } = url;
  const status = searchParams.get("status") ?? "unknown";
  const connectedAccountId = searchParams.get("connected_account_id") ?? "";
  const targetOrigin = url.origin;

  const success = status === "success";
  let resolvedConnection:
    | Awaited<ReturnType<typeof resolveConnectedToolkitSummary>>
    | undefined;
  if (success) {
    resolvedConnection = await resolveConnectedToolkitSummary(connectedAccountId);
    void (async () => {
      try {
        const rebuild = await rebuildComposioToolIndexIfReady();
        if (rebuild.ok) await refreshIntegrationsRuntime();
        await getComposioMcpHealth();
      } catch {}
    })();
  }
  const payloadJson = serializeForInlineScript({
    type: "composio-callback",
    status,
    connected_account_id: connectedAccountId,
    connected_toolkit_slug: resolvedConnection?.toolkit_slug ?? null,
    connected_toolkit_name: resolvedConnection?.toolkit_name ?? null,
    connected_status: resolvedConnection?.status ?? null,
  });
  const targetOriginJson = serializeForInlineScript(targetOrigin);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${success ? "Connected" : "Connection Failed"} — DenchClaw</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #09090b; color: #fafafa;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; padding: 2rem;
    }
    .card {
      max-width: 420px; width: 100%; text-align: center;
      padding: 3rem 2rem; border-radius: 1rem;
      border: 1px solid #27272a; background: #18181b;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #a1a1aa; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${success ? "&#10003;" : "&#10007;"}</div>
    <h1>${success ? "Connected successfully" : "Connection failed"}</h1>
    <p>${success ? "You can close this tab and return to DenchClaw." : "Something went wrong. Please close this tab and try again."}</p>
  </div>
  <script>
    try {
      const payload = ${payloadJson};
      const targetOrigin = ${targetOriginJson};
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, targetOrigin);
        setTimeout(() => window.close(), 150);
      }
    } catch (_) {}
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
