#!/usr/bin/env npx tsx
// SoundChain Forge — Standalone BYOK Server
// Runs independently of OpenClaw gateway. Serves /forge/agent, /forge/status, /forge/execute.
// User's API key in request body → Anthropic → tool execution → SSE back.
// Key never touches disk. True BYOK.
//
// Usage: npx tsx serve.ts [--port 3334]

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { runForgeAgent } from "./src/agent-loop.js";
import { createBashTool, createGitTool, createGlobTool, createGrepTool } from "./src/exec-tools.js";
import { createReadTool, createWriteTool, createEditTool } from "./src/file-tools.js";
import { PathGuard, BashGuard, GitGuard } from "./src/guards.js";

// ─── Config ──────────────────────────────────────────────────────────
const PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === "--port") || "3334", 10);
const ALLOWED_PATHS = ["/home/ubuntu/soundchain", "/home/ubuntu/openclaw", "/tmp"];
const REPO_DIR = "/home/ubuntu/soundchain";

// ─── Initialize guards and tools ─────────────────────────────────────
const pathGuard = new PathGuard(ALLOWED_PATHS);
const bashGuard = new BashGuard();
const gitGuard = new GitGuard();

const allTools = [
  createReadTool(pathGuard),
  createWriteTool(pathGuard),
  createEditTool(pathGuard),
  createBashTool(pathGuard, bashGuard, REPO_DIR),
  createGitTool(gitGuard, REPO_DIR),
  createGlobTool(pathGuard, REPO_DIR),
  createGrepTool(pathGuard, REPO_DIR),
];

const TOOL_NAMES = allTools.map((t) => t.name);

// ─── HTTP Helpers ────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

function corsHeaders(res: ServerResponse) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

// ─── Routes ──────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    corsHeaders(res);
    return;
  }

  // GET /forge/status
  if (path === "/forge/status" && req.method === "GET") {
    jsonResponse(res, 200, {
      status: "ONLINE",
      tools: TOOL_NAMES,
      repoDir: REPO_DIR,
      allowedPaths: ALLOWED_PATHS,
      version: "2026.2.20",
      mode: "BYOK_STANDALONE",
    });
    return;
  }

  // POST /forge/execute — single tool execution
  if (path === "/forge/execute" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON" });
      return;
    }

    const toolName = typeof body.tool === "string" ? body.tool : "";
    const params =
      typeof body.params === "object" && body.params !== null
        ? (body.params as Record<string, unknown>)
        : {};

    const tool = allTools.find((t) => t.name === toolName);
    if (!tool) {
      jsonResponse(res, 400, {
        error: `Unknown tool: ${toolName}. Available: ${TOOL_NAMES.join(", ")}`,
      });
      return;
    }

    try {
      const result = await tool.execute("http-exec", params);
      jsonResponse(res, 200, result);
    } catch (err: any) {
      jsonResponse(res, 500, { error: `Execution failed: ${err.message}` });
    }
    return;
  }

  // POST /forge/agent — BYOK agent loop (the key endpoint)
  if (path === "/forge/agent" && req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await parseBody(req));
    } catch {
      jsonResponse(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const model = typeof body.model === "string" ? body.model : undefined;

    if (!apiKey) {
      jsonResponse(res, 401, { error: "Missing apiKey — BYOK required" });
      return;
    }

    if (messages.length === 0) {
      jsonResponse(res, 400, { error: "Missing messages array" });
      return;
    }

    try {
      await runForgeAgent(res, apiKey, messages, allTools, model);
    } catch (err: any) {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: `Agent loop failed: ${err.message}` });
      }
    }
    return;
  }

  // 404
  jsonResponse(res, 404, { error: "Not found. Try /forge/status" });
}

// ─── Start ───────────────────────────────────────────────────────────

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("[forge-server] Unhandled:", err);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[forge-server] SoundChain Forge BYOK Server`);
  console.log(`[forge-server] Listening on http://0.0.0.0:${PORT}`);
  console.log(`[forge-server] Tools: ${TOOL_NAMES.join(", ")}`);
  console.log(`[forge-server] Repo: ${REPO_DIR}`);
  console.log(`[forge-server] Mode: BYOK — key per-request, never stored`);
});
