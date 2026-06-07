#!/usr/bin/env node
/**
 * graphiti-proxy — capability boundary between OpenClaw's mcp-bridge and the
 * Graphiti MCP server (Phase 2 of life-per-user-memory).
 *
 * mcp-bridge spawns this as a stdio child inside the `life` container. It speaks
 * newline-delimited JSON-RPC (MCP) on stdio to mcp-bridge, and streamable-HTTP
 * (MCP) to the Graphiti container.
 *
 * SECURITY MODEL (why this process exists):
 *   1. ALLOWLIST — only the safe, group-scoped tools are exposed. The dangerous
 *      Graphiti tools (get_entity_edge, delete_entity_edge, delete_episode,
 *      clear_graph) are never advertised and are hard-rejected if called.
 *   2. HARD-PINNED group_id — the model never sees or supplies a group id. The
 *      gateway `before_tool_call` hook injects a reserved `__group_id` into every
 *      call's params; this proxy forces that value onto Graphiti's group_id /
 *      group_ids and FAILS CLOSED if it is missing. The model cannot widen,
 *      override, or omit the scope.
 *   3. center_node_uuid is stripped (a foreign-UUID ranking side channel).
 *
 * Env:
 *   GRAPHITI_URL          default http://graphiti-mcp:8000/mcp
 *   GRAPHITI_HOST_HEADER  default localhost:8000   (Graphiti rejects non-localhost Host)
 */

"use strict";
const http = require("node:http");
const { URL } = require("node:url");
const readline = require("node:readline");

const GRAPHITI_URL = process.env.GRAPHITI_URL || "http://graphiti-mcp:8000/mcp";
const HOST_HEADER = process.env.GRAPHITI_HOST_HEADER || "localhost:8000";
const RESERVED = "__group_id"; // injected by the gateway hook; never in the model-facing schema

// ── Model-facing tool surface (NO group field — scoping is server-side) ──────
const TOOLS = [
  {
    name: "add_memory",
    description:
      "Save a memory about THIS user to long-term memory. Call after meaningful exchanges. " +
      "Memory is automatically scoped to the current user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short title for this memory." },
        episode_body: { type: "string", description: "The content to remember (plain text)." },
      },
      required: ["name", "episode_body"],
    },
  },
  {
    name: "search_memory_facts",
    description:
      "Search THIS user's memory for relevant facts (relationships) using a natural-language query. " +
      "Use before answering to recall what you know about the user.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query." },
        max_facts: { type: "number", description: "Max facts to return (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "search_nodes",
    description: "Search THIS user's memory for relevant entities (people, places, things).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language query." },
        max_nodes: { type: "number", description: "Max nodes to return (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_episodes",
    description: "Retrieve the most recent raw memory episodes for THIS user.",
    inputSchema: {
      type: "object",
      properties: {
        last_n: { type: "number", description: "How many recent episodes (default 10)." },
      },
    },
  },
];
const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

// ── Map a model call → a scoped upstream Graphiti call ───────────────────────
// Returns { tool, args } for Graphiti, or throws to fail closed.
function buildUpstreamCall(name, rawArgs) {
  const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
  const groupId = typeof args[RESERVED] === "string" ? args[RESERVED].trim() : "";
  delete args[RESERVED]; // never forward the reserved key
  if (!TOOL_NAMES.has(name)) {
    throw new Error(`tool "${name}" is not permitted`);
  }
  if (!groupId) {
    throw new Error("no user scope on this call (missing pinned group id) — refusing");
  }
  if (!/^[A-Za-z0-9_]+$/.test(groupId)) {
    throw new Error("pinned group id has unsafe characters");
  }

  switch (name) {
    case "add_memory":
      return {
        tool: "add_memory",
        args: {
          name: String(args.name ?? ""),
          episode_body: String(args.episode_body ?? ""),
          group_id: groupId,
        },
      };
    case "search_memory_facts":
      return {
        tool: "search_memory_facts",
        // center_node_uuid intentionally NOT forwarded
        args: {
          query: String(args.query ?? ""),
          max_facts: clampNum(args.max_facts, 10),
          group_ids: [groupId],
        },
      };
    case "search_nodes":
      return {
        tool: "search_nodes",
        args: {
          query: String(args.query ?? ""),
          max_nodes: clampNum(args.max_nodes, 10),
          group_ids: [groupId],
        },
      };
    case "get_episodes":
      return {
        tool: "get_episodes",
        args: { max_episodes: clampNum(args.last_n, 10), group_ids: [groupId] },
      };
    default:
      throw new Error(`tool "${name}" is not permitted`);
  }
}
function clampNum(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 50) : def;
}

// ── Upstream Graphiti streamable-HTTP MCP client ─────────────────────────────
let upstreamSession = null;
let nextUpId = 1;

function upstreamRequest(method, params, { notify = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(GRAPHITI_URL);
    const payload = JSON.stringify(
      notify
        ? { jsonrpc: "2.0", method, params: params || {} }
        : { jsonrpc: "2.0", id: nextUpId++, method, params: params || {} },
    );
    const headers = {
      Host: HOST_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2024-11-05",
      "Content-Length": Buffer.byteLength(payload),
    };
    if (upstreamSession) {
      headers["Mcp-Session-Id"] = upstreamSession;
    }
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", headers },
      (res) => {
        const sid = res.headers["mcp-session-id"];
        if (sid) {
          upstreamSession = sid;
        }
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (notify) {
            return resolve(null);
          }
          const json = parseSse(body);
          if (!json) {
            return reject(
              new Error(`bad upstream response (${res.statusCode}): ${body.slice(0, 200)}`),
            );
          }
          if (json.error) {
            return reject(new Error(json.error.message || JSON.stringify(json.error)));
          }
          resolve(json.result);
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("upstream timeout")));
    req.end(payload);
  });
}
// Graphiti replies as SSE: lines of "data: {json}". Fall back to plain JSON.
function parseSse(body) {
  const lines = body.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const raw = lines.length ? lines.map((l) => l.slice(5).trim()).join("") : body.trim();
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let upstreamReady = null;
function ensureUpstream() {
  if (!upstreamReady) {
    upstreamReady = (async () => {
      await upstreamRequest("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "graphiti-proxy", version: "1.0.0" },
      });
      await upstreamRequest("notifications/initialized", {}, { notify: true });
    })();
  }
  return upstreamReady;
}

// ── Downstream stdio MCP server (talks to mcp-bridge) ────────────────────────
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}
function replyErr(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}
function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "graphiti-proxy", version: "1.0.0" },
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return;
  } // no reply
  if (method === "ping") {
    return reply(id, {});
  }
  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }
  if (method === "tools/call") {
    const name = params?.name;
    try {
      const { tool, args } = buildUpstreamCall(name, params?.arguments);
      await ensureUpstream();
      const result = await upstreamRequest("tools/call", { name: tool, arguments: args });
      return reply(id, result);
    } catch (err) {
      // surface as a tool error (not a protocol error) so the model can react
      return reply(id, {
        content: [{ type: "text", text: `[graphiti-proxy] ${err.message}` }],
        isError: true,
      });
    }
  }
  if (id != null) {
    replyErr(id, -32601, `method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  Promise.resolve(handle(msg)).catch((e) => {
    if (msg && msg.id != null) {
      replyErr(msg.id, -32603, String(e && e.message ? e.message : e));
    }
  });
});
process.stdin.on("end", () => process.exit(0));
