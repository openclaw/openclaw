// SoundChain Forge — Coding agent extension for OpenClaw
// 7 tools: read, write, edit, bash, git, glob, grep
// Secured with PathGuard, BashGuard, GitGuard.
// Zero booleans for state.

import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolFactory,
} from "../../src/plugins/types.js";
import { runForgeAgent } from "./src/agent-loop.js";
import { createBashTool, createGitTool, createGlobTool, createGrepTool } from "./src/exec-tools.js";
import { createReadTool, createWriteTool, createEditTool } from "./src/file-tools.js";
import { PathGuard, BashGuard, GitGuard } from "./src/guards.js";

// ---------------------------------------------------------------------------
// Helper — JSON tool result
// ---------------------------------------------------------------------------

function json<T>(payload: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// HTTP Helpers
// ---------------------------------------------------------------------------

function parseRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 512 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
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

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const TOOL_NAMES = [
  "forge_read",
  "forge_write",
  "forge_edit",
  "forge_bash",
  "forge_git",
  "forge_glob",
  "forge_grep",
];

export default {
  id: "soundchain-forge",
  name: "SoundChain Forge",
  description:
    "Coding agent tools for SMITH v2. Read, write, edit files. Run bash, git, glob, grep. " +
    "Secured with path/command guards. The forge that builds the forge.",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as Record<string, unknown>;

    // Config with defaults
    const allowedPaths: string[] = Array.isArray(cfg.allowedPaths)
      ? cfg.allowedPaths.filter((p): p is string => typeof p === "string")
      : ["/home/ubuntu/soundchain", "/tmp"];

    const repoDir =
      typeof cfg.repoDir === "string" && cfg.repoDir ? cfg.repoDir : "/home/ubuntu/soundchain";

    // Initialize guards
    const pathGuard = new PathGuard(allowedPaths);
    const bashGuard = new BashGuard();
    const gitGuard = new GitGuard();

    // Create all 7 tools
    const allTools: AnyAgentTool[] = [
      createReadTool(pathGuard),
      createWriteTool(pathGuard),
      createEditTool(pathGuard),
      createBashTool(pathGuard, bashGuard, repoDir),
      createGitTool(gitGuard, repoDir),
      createGlobTool(pathGuard, repoDir),
      createGrepTool(pathGuard, repoDir),
    ];

    // Register tools — no tools in sandbox mode
    const toolFactory: OpenClawPluginToolFactory = (ctx) => {
      if (ctx.sandboxed) return null;
      return allTools;
    };
    api.registerTool(toolFactory, { optional: true });

    // ─── HTTP Route: GET /forge/status ────────────────────────────────
    api.registerHttpRoute({
      path: "/forge/status",
      handler: async (_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            status: "ONLINE",
            tools: TOOL_NAMES,
            repoDir,
            allowedPaths,
            version: "2026.2.19",
          }),
        );
      },
    });

    // ─── HTTP Route: POST /forge/execute ──────────────────────────────
    api.registerHttpRoute({
      path: "/forge/execute",
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        let body: Record<string, unknown>;
        try {
          const raw = await parseRequestBody(req);
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        const toolName = typeof body.tool === "string" ? body.tool : "";
        const params =
          typeof body.params === "object" && body.params !== null
            ? (body.params as Record<string, unknown>)
            : {};

        const tool = allTools.find((t) => t.name === toolName);
        if (!tool) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: `Unknown tool: ${toolName}. Available: ${TOOL_NAMES.join(", ")}`,
            }),
          );
          return;
        }

        try {
          const result = await tool.execute("http-exec", params);
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
        } catch (err: any) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `Execution failed: ${err.message}` }));
        }
      },
    });

    // ─── HTTP Route: POST /forge/agent (BYOK Agent Loop) ─────────────
    // The key endpoint. User's API key flows in the request body,
    // hits Anthropic, tool calls execute locally, streams SSE back.
    // Key never touches disk. True BYOK.
    api.registerHttpRoute({
      path: "/forge/agent",
      handler: async (req, res) => {
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
            "Access-Control-Max-Age": "86400",
          });
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        let body: Record<string, unknown>;
        try {
          const raw = await parseRequestBody(req);
          body = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
          return;
        }

        const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const model = typeof body.model === "string" ? body.model : undefined;

        if (!apiKey) {
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing apiKey — BYOK required" }));
          return;
        }

        if (messages.length === 0) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing messages array" }));
          return;
        }

        // Run the agent loop with the user's key
        try {
          await runForgeAgent(res, apiKey, messages, allTools, model);
        } catch (err: any) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `Agent loop failed: ${err.message}` }));
          }
        }
      },
    });

    // ─── /forge command ──────────────────────────────────────────────
    api.registerCommand({
      name: "forge",
      description: "SoundChain Forge — coding agent status and tool list",
      acceptsArgs: true,
      handler: async (ctx) => {
        const sub = (ctx.args ?? "").trim().toLowerCase();

        if (sub === "tools") {
          return {
            text: [
              "SoundChain Forge Tools:",
              "",
              "  forge_read   — Read file with line numbers",
              "  forge_write  — Create or overwrite file (atomic)",
              "  forge_edit   — String replacement in file",
              "  forge_bash   — Execute shell command",
              "  forge_git    — Safe git operations",
              "  forge_glob   — File pattern matching",
              "  forge_grep   — Content search (regex)",
              "",
              `Repo: ${repoDir}`,
              `Allowed paths: ${allowedPaths.join(", ")}`,
            ].join("\n"),
          };
        }

        return {
          text: [
            "SoundChain Forge — SMITH v2 Coding Agent",
            "",
            `  Status: ONLINE`,
            `  Tools: ${TOOL_NAMES.length}`,
            `  Repo: ${repoDir}`,
            "",
            "  /forge tools — list all tools",
          ].join("\n"),
        };
      },
    });
  },
};
