/**
 * claude-cli: an opinionated Claude CLI backend preset.
 *
 * Users configure it with just `command` and (optionally) `token`:
 *
 *   "cliBackends": {
 *     "claude-cli": {
 *       "command": "/usr/local/bin/claude",
 *       "token": "sk-ant-oat01-..."
 *     }
 *   }
 *
 * Everything else — session management, streaming args, model aliases,
 * auth helpers, and the MCP message bridge — is auto-configured.
 */

import crypto from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliBackendConfig } from "../../config/types.js";

const CLI_AUTO_DIR = path.join(os.tmpdir(), "openclaw-managed-cli");

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const MANAGED_DEFAULTS: Omit<CliBackendConfig, "command"> = {
  args: [],
  resumeArgs: ["--resume", "{sessionId}"],
  output: "jsonl",
  input: "stdin",
  modelArg: "--model",
  modelAliases: {
    opus: "opus",
    "opus-4.6": "opus",
    "opus-4.5": "opus",
    "opus-4": "opus",
    "claude-opus-4-6": "opus",
    "claude-opus-4-5": "opus",
    "claude-opus-4": "opus",
    sonnet: "sonnet",
    "sonnet-4.6": "sonnet",
    "sonnet-4.5": "sonnet",
    "sonnet-4.1": "sonnet",
    "sonnet-4.0": "sonnet",
    "claude-sonnet-4-6": "sonnet",
    "claude-sonnet-4-5": "sonnet",
    "claude-sonnet-4-1": "sonnet",
    "claude-sonnet-4-0": "sonnet",
    haiku: "haiku",
    "haiku-3.5": "haiku",
    "claude-haiku-3-5": "haiku",
  },
  sessionArg: "--session-id",
  sessionMode: "managed",
  sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
  systemPromptArg: "--append-system-prompt",
  systemPromptMode: "append",
  systemPromptWhen: "first",
  clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
  serialize: false,
};

/**
 * Merges user-provided overrides on top of managed defaults.
 * User values always win.
 */
export function buildManagedClaudeCliConfig(userConfig: CliBackendConfig): CliBackendConfig {
  const merged: Record<string, unknown> = { ...MANAGED_DEFAULTS, ...userConfig };
  // Merge model aliases additively so user additions layer on top.
  if (MANAGED_DEFAULTS.modelAliases || userConfig.modelAliases) {
    merged.modelAliases = {
      ...MANAGED_DEFAULTS.modelAliases,
      ...userConfig.modelAliases,
    };
  }
  // Merge clearEnv additively.
  if (MANAGED_DEFAULTS.clearEnv || userConfig.clearEnv) {
    merged.clearEnv = Array.from(
      new Set([...(MANAGED_DEFAULTS.clearEnv ?? []), ...(userConfig.clearEnv ?? [])]),
    );
  }
  return merged as CliBackendConfig;
}

// ---------------------------------------------------------------------------
// CLI arg injection
// ---------------------------------------------------------------------------

function ensureAutoDir(): void {
  try {
    fsSync.mkdirSync(CLI_AUTO_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // Directory may already exist.
  }
}

function ensureTokenHelper(token: string): string {
  ensureAutoDir();
  const hash = crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
  const tokenFile = path.join(CLI_AUTO_DIR, `.token-${hash}`);
  const helperFile = path.join(CLI_AUTO_DIR, `helper-${hash}.sh`);
  fsSync.writeFileSync(tokenFile, token, { mode: 0o600 });
  if (!fsSync.existsSync(helperFile)) {
    fsSync.writeFileSync(helperFile, `#!/bin/bash\ncat "${tokenFile}"\n`, { mode: 0o700 });
  }
  return helperFile;
}

// ---------------------------------------------------------------------------
// MCP message bridge (auto-generated at runtime)
// ---------------------------------------------------------------------------

const MCP_SERVER_SCRIPT = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
const CONFIG_PATH = join(homedir(), ".openclaw", "openclaw.json");
function loadConfig() { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")); }
function write(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function respond(id, result) { write({ jsonrpc: "2.0", id, result }); }
function respondError(id, code, message) { write({ jsonrpc: "2.0", id, error: { code, message } }); }
async function slackPost(botToken, { channel, text, thread_ts }) {
  const body = { channel, text }; if (thread_ts) body.thread_ts = thread_ts;
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST", headers: { Authorization: "Bearer " + botToken, "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  const data = await res.json(); if (!data.ok) throw new Error("Slack: " + data.error); return data;
}
const TOOLS = [{ name: "message", description: "Send a message to a Slack channel or DM.",
  inputSchema: { type: "object", properties: {
    channel: { type: "string", description: "Slack channel ID" },
    text: { type: "string", description: "Message text (Slack markdown)" },
    thread_ts: { type: "string", description: "Thread timestamp for in-thread reply" }
  }, required: ["channel", "text"] } }];
async function handle(req) {
  const { id, method, params } = req;
  if (method === "initialize") return respond(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "openclaw-tools", version: "1.0.0" } });
  if (method === "notifications/initialized") return;
  if (method === "tools/list") return respond(id, { tools: TOOLS });
  if (method === "tools/call") {
    if (params.name === "message") {
      try { const cfg = loadConfig(); const t = cfg.channels?.slack?.botToken;
        if (!t) throw new Error("No Slack bot token in openclaw.json");
        await slackPost(t, params.arguments);
        return respond(id, { content: [{ type: "text", text: "Message sent to " + params.arguments.channel + (params.arguments.thread_ts ? " (thread)" : "") }] });
      } catch (e) { return respond(id, { content: [{ type: "text", text: "Error: " + e.message }], isError: true }); }
    }
    return respondError(id, -32001, "Unknown tool: " + params.name);
  }
  if (id !== undefined) return respondError(id, -32601, "Method not found: " + method);
}
let pending = 0, closed = false;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (l) => { pending++; try { await handle(JSON.parse(l)); } catch { write({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }); } pending--; if (closed && pending === 0) process.exit(0); });
rl.on("close", () => { closed = true; if (pending === 0) process.exit(0); });
`;

let mcpConfigPath: string | null = null;

function ensureMcpBridge(): string {
  if (mcpConfigPath) {
    return mcpConfigPath;
  }
  ensureAutoDir();
  const scriptPath = path.join(CLI_AUTO_DIR, "openclaw-tools-mcp.mjs");
  const configPath = path.join(CLI_AUTO_DIR, "openclaw-tools-mcp.json");
  fsSync.writeFileSync(scriptPath, MCP_SERVER_SCRIPT, { mode: 0o700 });
  fsSync.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: { "openclaw-tools": { command: "node", args: [scriptPath] } },
    }),
    { mode: 0o644 },
  );
  mcpConfigPath = configPath;
  return configPath;
}

// ---------------------------------------------------------------------------
// Public: inject CLI flags for claude-cli runs
// ---------------------------------------------------------------------------

/**
 * Auto-injects CLI flags required for the claude-cli managed integration.
 * Only injects flags not already present in args so user overrides win.
 */
export function injectManagedClaudeCliArgs(
  args: string[],
  backendId: string,
  backend?: CliBackendConfig,
): string[] {
  if (backendId !== "claude-cli") {
    return args;
  }
  const joined = args.join(" ");
  const out = [...args];

  if (!args.includes("--bare")) {
    out.unshift("--bare");
  }
  if (!args.includes("-p") && !args.includes("--print")) {
    out.unshift("-p");
  }
  if (!joined.includes("--output-format")) {
    out.push("--output-format", "stream-json");
  }
  if (!args.includes("--verbose")) {
    out.push("--verbose");
  }
  if (!args.includes("--dangerously-skip-permissions")) {
    out.push("--dangerously-skip-permissions");
  }
  if (backend?.token && !joined.includes("--settings")) {
    const helperPath = ensureTokenHelper(backend.token);
    out.push("--settings", JSON.stringify({ apiKeyHelper: helperPath }));
  }
  if (!joined.includes("--mcp-config")) {
    const mcpPath = ensureMcpBridge();
    out.push("--mcp-config", mcpPath);
  }

  return out;
}
