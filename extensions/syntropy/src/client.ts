/**
 * HTTP client for calling Syntropy MCP tools via Streamable HTTP transport.
 *
 * Uses a stored Syntropy API token (issued during pairing) for standard
 * Bearer auth.  No compound tokens or service keys.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyntropyToolResult {
  data: unknown;
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Call a Syntropy MCP tool on behalf of a verified user.
 *
 * @param baseUrl    Syntropy base URL (e.g., "http://localhost:3000")
 * @param authToken  The stored `sj_<short>_<long>` API token
 * @param toolName   MCP tool name (e.g., "log_food")
 * @param args       Tool arguments
 */
export async function callSyntropyTool(
  baseUrl: string,
  authToken: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<SyntropyToolResult> {
  const url = `${baseUrl}/mcp`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: toolName, arguments: args },
        id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { data: null, ok: false, error: `Syntropy returned ${resp.status}: ${text}` };
    }

    const json = (await resp.json()) as Record<string, unknown>;

    // JSON-RPC error envelope
    if (json.error && typeof json.error === "object") {
      const err = json.error as { message?: string };
      return { data: null, ok: false, error: err.message ?? "MCP tool error" };
    }

    // JSON-RPC success — unwrap MCP tool result
    const result = json.result ?? json;

    if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
      const content = (result as { content: Array<{ type: string; text?: string }> }).content;
      const textParts = content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text as string);
      if (textParts.length > 0) {
        try {
          return { data: JSON.parse(textParts.join("")), ok: true };
        } catch {
          return { data: textParts.join(""), ok: true };
        }
      }
    }

    return { data: result, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { data: null, ok: false, error: `Syntropy call failed: ${msg}` };
  }
}
