import http from "node:http";
import { URL } from "node:url";

/**
 * Direct, read-only Graphiti recall client for deterministic memory injection.
 *
 * The agent already has the `mcp__graphiti__*` tools (via graphiti-proxy), but it
 * must CHOOSE to call `search_memory_facts`, and under the slim app prompt it often
 * skips that at the start of a new chat — so prior goals/facts aren't recalled.
 * This client lets the gateway fetch the top durable facts server-side and inject
 * them as a synthetic `MEMORY_RECALL.md` bootstrap file every turn (see
 * memory-recall-context.ts), independent of the agent's tool loop.
 *
 * SECURITY — mirrors the graphiti-proxy capability boundary (ops/graphiti-life/
 * proxy/graphiti-proxy.js `buildUpstreamCall`):
 *   - the ONLY scope input is a server-derived `groupId`;
 *   - unsafe / missing group ids FAIL CLOSED (throw, never query the whole graph);
 *   - the outbound call hard-sets `group_ids: [groupId]` and forwards NOTHING else
 *     scope-related — there is no parameter by which a caller could supply
 *     `group_id`, `group_ids`, or `center_node_uuid`, so they can never pass through.
 *
 * Uses node:http (not fetch) to send the `Host: localhost:8000` header the Graphiti
 * MCP server requires — exactly as the proven proxy does.
 */

const DEFAULT_GRAPHITI_URL = "http://graphiti-mcp:8000/mcp";
const DEFAULT_HOST_HEADER = "localhost:8000";

/** RediSearch-safe group id (same charset the proxy enforces). */
export const SAFE_GROUP_ID = /^[A-Za-z0-9_]+$/;

export interface SearchMemoryFactsParams {
  /** Server-derived group id (e.g. `app_<userId>`). Required; validated. */
  groupId: string;
  query: string;
  maxFacts?: number;
  timeoutMs?: number;
  /** Override the endpoint (tests / non-default deploys). */
  url?: string;
  hostHeader?: string;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { message?: string };
}

/** Graphiti replies as SSE (`data: {json}`); fall back to plain JSON. (proxy parity) */
export function parseSse(body: string): unknown {
  const lines = body.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const raw = lines.length ? lines.map((l) => l.slice(5).trim()).join("") : body.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clampMaxFacts(v: number | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : def;
}

interface GraphitiFact {
  fact?: unknown;
  expired_at?: unknown;
  invalid_at?: unknown;
}

/**
 * Pull plain fact strings out of a `search_memory_facts` result, preferring the
 * `structuredContent.result.facts` array and falling back to the JSON embedded in
 * `content[0].text`. Skips expired/invalidated facts. Pure + exported for tests.
 */
export function extractFacts(result: unknown, max = 8): string[] {
  const out: string[] = [];
  const take = (arr: unknown): void => {
    if (!Array.isArray(arr)) {
      return;
    }
    for (const f of arr as GraphitiFact[]) {
      if (f && typeof f.fact === "string" && f.expired_at == null && f.invalid_at == null) {
        const s = f.fact.trim();
        if (s) {
          out.push(s);
        }
      }
    }
  };
  const r = result as { structuredContent?: { result?: { facts?: unknown } }; content?: unknown[] };
  take(r?.structuredContent?.result?.facts);
  if (out.length === 0) {
    const text = (r?.content?.[0] as { text?: unknown } | undefined)?.text;
    if (typeof text === "string") {
      try {
        take((JSON.parse(text) as { facts?: unknown })?.facts);
      } catch {
        /* not JSON — nothing to extract */
      }
    }
  }
  return out.slice(0, max);
}

/** One JSON-RPC POST to the streamable-HTTP MCP endpoint. Resolves the parsed body + session id. */
function rpc(opts: {
  url: string;
  hostHeader: string;
  sessionId?: string;
  method: string;
  params?: unknown;
  notify?: boolean;
  signal: AbortSignal;
}): Promise<{ json: JsonRpcResponse | null; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(opts.url);
    const payload = JSON.stringify(
      opts.notify
        ? { jsonrpc: "2.0", method: opts.method, params: opts.params ?? {} }
        : { jsonrpc: "2.0", id: 1, method: opts.method, params: opts.params ?? {} },
    );
    const headers: http.OutgoingHttpHeaders = {
      Host: opts.hostHeader,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2024-11-05",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (opts.sessionId) {
      headers["Mcp-Session-Id"] = opts.sessionId;
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        const sid = (res.headers["mcp-session-id"] as string | undefined) ?? opts.sessionId;
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            json: opts.notify ? null : (parseSse(body) as JsonRpcResponse | null),
            sessionId: sid,
          }),
        );
      },
    );
    req.on("error", reject);
    const onAbort = (): void => {
      req.destroy(new Error("graphiti-recall: aborted (timeout)"));
    };
    if (opts.signal.aborted) {
      onAbort();
    } else {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }
    req.end(payload);
  });
}

/**
 * Search the given (server-derived) group's memory and return the top fact strings.
 * Throws on an unsafe/missing group id (fail closed) or on transport/abort errors —
 * the caller (memory-recall-context) treats any throw as fail-open.
 */
export async function searchMemoryFacts(params: SearchMemoryFactsParams): Promise<string[]> {
  const groupId = params.groupId;
  if (typeof groupId !== "string" || !SAFE_GROUP_ID.test(groupId)) {
    throw new Error("graphiti-recall: unsafe or missing group id — refusing");
  }
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (!query) {
    return [];
  }
  const url = params.url ?? process.env.GRAPHITI_URL ?? DEFAULT_GRAPHITI_URL;
  const hostHeader = params.hostHeader ?? process.env.GRAPHITI_HOST_HEADER ?? DEFAULT_HOST_HEADER;
  const maxFacts = clampMaxFacts(params.maxFacts, 8);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 2500);
  try {
    const init = await rpc({
      url,
      hostHeader,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "graphiti-recall", version: "1.0.0" },
      },
      signal: controller.signal,
    });
    const sessionId = init.sessionId;
    await rpc({
      url,
      hostHeader,
      sessionId,
      method: "notifications/initialized",
      notify: true,
      signal: controller.signal,
    });
    const res = await rpc({
      url,
      hostHeader,
      sessionId,
      method: "tools/call",
      // Scope is hard-set here; no caller-supplied group_id/group_ids/center_node_uuid exists.
      params: {
        name: "search_memory_facts",
        arguments: { query, max_facts: maxFacts, group_ids: [groupId] },
      },
      signal: controller.signal,
    });
    if (!res.json || res.json.error) {
      throw new Error(res.json?.error?.message ?? "graphiti-recall: bad upstream response");
    }
    return extractFacts(res.json.result, maxFacts);
  } finally {
    clearTimeout(timer);
  }
}
