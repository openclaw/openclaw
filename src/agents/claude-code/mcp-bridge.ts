/**
 * MCP bridge server for Claude Code spawn mode.
 *
 * Exposes OpenClaw context tools to the spawned CC session via a stdio-based
 * MCP server. This follows the same pattern as the VS Code extension which
 * injects `claude-vscode` as an MCP server.
 *
 * Phase 3: stateful bridge with budget tracking, announce relay, and all 4 tools.
 *
 * Transport: The bridge is a self-contained Node.js script written to a temp
 * file and referenced in `--mcp-config`. CC's MCP client spawns it and
 * communicates via stdin/stdout JSON-RPC.
 *
 * Announce relay: The bridge writes announce messages to a temp file. The
 * runner polls this file and relays announcements to the gateway.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeCodeSpawnOptions, DiscoveredSession } from "./types.js";

export type McpBridgeHandle = {
  /** MCP config object for `--mcp-config` injection. */
  mcpConfig: Record<string, unknown>;
  /** Path to the announce queue file (NDJSON). */
  announceQueuePath: string;
  /** Read and drain pending announce messages. */
  drainAnnouncements(): string[];
  /** Stop the bridge server and clean up. */
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Bridge server script generator
// ---------------------------------------------------------------------------

function generateBridgeScript(options: {
  task: string;
  agentId?: string;
  repo: string;
  maxBudgetUsd?: number;
  announceQueuePath: string;
  workspaceDir?: string;
  recentSessions?: DiscoveredSession[];
  activeSessions?: Array<{ sessionId: string; repoPath: string }>;
}): string {
  const taskJson = JSON.stringify(options.task);
  const agentIdJson = JSON.stringify(options.agentId ?? "default");
  const repoJson = JSON.stringify(options.repo);
  const budgetJson = JSON.stringify(options.maxBudgetUsd ?? null);
  const announcePathJson = JSON.stringify(options.announceQueuePath);
  const workspaceDirJson = JSON.stringify(
    options.workspaceDir ??
      path.join(os.homedir(), ".openclaw", "agents", options.agentId ?? "default"),
  );
  // Serialize session data for injection into the bridge script
  const recentSessionsJson = JSON.stringify(
    (options.recentSessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      source: s.source,
      agentId: s.agentId,
      branch: s.branch,
      firstMessage: s.firstMessage,
      lastModified: s.lastModified.toISOString(),
      messageCount: s.messageCount,
      totalCostUsd: s.totalCostUsd,
      totalTurns: s.totalTurns,
      lastTask: s.lastTask,
      label: s.label,
      isRunning: s.isRunning,
    })),
  );
  const activeSessionsJson = JSON.stringify(options.activeSessions ?? []);

  return `
"use strict";
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const os = require("os");

const rl = readline.createInterface({ input: process.stdin });

// TODO: budget tracking is non-functional — totalCostUsd is never updated
let totalCostUsd = 0;
const maxBudgetUsd = ${budgetJson};

const CONFIG = {
  repoPath: ${repoJson},
  recentSessions: ${recentSessionsJson},
  activeSessions: ${activeSessionsJson},
};

const TOOLS = [
  {
    name: "openclaw_conversation_context",
    description: "Returns context about the OpenClaw conversation that triggered this Claude Code session. Call this to understand why you were invoked and what task you should accomplish.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openclaw_memory_search",
    description: "Search OpenClaw memory files for relevant context. Returns matching content from the agent's memory and workspace memory directories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (case-insensitive substring match)" },
      },
      required: ["query"],
    },
  },
  {
    name: "openclaw_announce",
    description: "Send a progress message back to the user's chat channel. Use this to keep the user informed about significant progress milestones. Messages are delivered asynchronously.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message to send to the user" },
      },
      required: ["message"],
    },
  },
  {
    name: "openclaw_session_info",
    description: "Returns metadata about the current OpenClaw session: agent ID, repo path, task description, cost budget remaining.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openclaw_project_status",
    description: "Returns the current project status including git state, recent commits, open PRs, active sessions, and available documentation. Call this before starting work to understand what's changed.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "openclaw_session_list",
    description: "Lists all Claude Code sessions for this repository, from any source (this agent, other agents, VSCode, CLI). Use to understand prior work and decide whether to build on existing context.",
    inputSchema: {
      type: "object",
      properties: {
        include_native: { type: "boolean", description: "Include sessions not spawned by OpenClaw (VSCode, CLI). Default: true" },
      },
      required: [],
    },
  },
];

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\\n");
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\\n");
}

function searchMemoryFiles(query) {
  const lowerQuery = query.toLowerCase();
  const results = [];
  const searchDirs = [
    path.join(${workspaceDirJson}, "memory"),
    // Also search the workspace root for MEMORY.md
    ${workspaceDirJson},
  ];

  for (const dir of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const file of entries) {
        if (!file.endsWith(".md")) continue;
        const filePath = path.join(dir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) continue;
          const content = fs.readFileSync(filePath, "utf8");
          if (content.toLowerCase().includes(lowerQuery)) {
            results.push({
              file: path.relative(${workspaceDirJson}, filePath),
              content: content.slice(0, 3000),
            });
          }
        } catch {}
      }
    } catch {}
  }
  return results;
}

function handleRequest(parsed) {
  const { id, method, params } = parsed;

  if (method === "initialize") {
    return respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "openclaw-bridge", version: "2.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return; // No response needed
  }

  if (method === "tools/list") {
    return respond(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};

    // Budget gate: refuse all tools if budget exhausted
    if (maxBudgetUsd !== null && totalCostUsd >= maxBudgetUsd) {
      return respond(id, {
        content: [{
          type: "text",
          text: "Budget exhausted ($" + totalCostUsd.toFixed(2) + " / $" + maxBudgetUsd.toFixed(2) + "). Tool call refused.",
        }],
        isError: true,
      });
    }

    switch (toolName) {
      case "openclaw_conversation_context":
        return respond(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              task: ${taskJson},
              agentId: ${agentIdJson},
              repo: ${repoJson},
              note: "You were spawned by OpenClaw to handle this task. Complete it and return your findings.",
              budgetRemaining: maxBudgetUsd !== null
                ? "$" + (maxBudgetUsd - totalCostUsd).toFixed(2)
                : "unlimited",
            }, null, 2),
          }],
        });

      case "openclaw_memory_search": {
        const query = toolArgs.query || "";
        if (!query.trim()) {
          return respond(id, {
            content: [{ type: "text", text: "Please provide a non-empty search query." }],
            isError: true,
          });
        }
        const results = searchMemoryFiles(query);
        return respond(id, {
          content: [{
            type: "text",
            text: results.length > 0
              ? JSON.stringify(results, null, 2)
              : "No matching memory files found for query: " + JSON.stringify(query),
          }],
        });
      }

      case "openclaw_announce": {
        const message = toolArgs.message || "";
        if (!message.trim()) {
          return respond(id, {
            content: [{ type: "text", text: "Please provide a non-empty message." }],
            isError: true,
          });
        }
        // Write to announce queue file — the runner picks these up
        try {
          const entry = JSON.stringify({ message, timestamp: new Date().toISOString() });
          fs.appendFileSync(${announcePathJson}, entry + "\\n", "utf8");
        } catch (err) {
          process.stderr.write("[openclaw-bridge] announce write error: " + err.message + "\\n");
        }
        return respond(id, {
          content: [{ type: "text", text: "Message queued for delivery to user's chat." }],
        });
      }

      case "openclaw_session_info":
        return respond(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              agentId: ${agentIdJson},
              repo: ${repoJson},
              task: ${taskJson},
              costAccumulatedUsd: totalCostUsd,
              budgetMaxUsd: maxBudgetUsd,
              budgetRemainingUsd: maxBudgetUsd !== null
                ? maxBudgetUsd - totalCostUsd
                : null,
            }, null, 2),
          }],
        });

      case "openclaw_project_status": {
        const { execSync } = require("child_process");
        const repoPath = CONFIG.repoPath;

        const run = (cmd) => {
          try { return execSync(cmd, { cwd: repoPath, timeout: 5000 }).toString().trim(); }
          catch { return ""; }
        };

        const branch = run("git branch --show-current");
        const headCommit = run("git log -1 --format='%h — %s'");
        const status = run("git status --short").split("\\n").filter(Boolean);
        const stashCount = run("git stash list").split("\\n").filter(Boolean).length;
        const recentCommits = run("git log --oneline -10 --format='%h|%s|%an|%ar'")
          .split("\\n").filter(Boolean)
          .map(function(l) { var p = l.split("|"); return { sha: p[0], message: p[1], author: p[2], date: p[3] }; });

        // Check docs
        const docs = {
          claudeMd: fs.existsSync(path.join(repoPath, "CLAUDE.md")),
          specs: fs.existsSync(path.join(repoPath, ".specs"))
            ? fs.readdirSync(path.join(repoPath, ".specs")).filter(function(f) { return f.endsWith(".md"); })
            : [],
          todo: fs.existsSync(path.join(repoPath, "TODO.md")),
        };

        // Open PRs (if gh available)
        var openPrs = [];
        try {
          var prJson = run("gh pr list --json number,title,headRefName,state --limit 5");
          if (prJson) openPrs = JSON.parse(prJson);
        } catch(e) {}

        return respond(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              repo: path.basename(repoPath),
              branch: branch,
              headCommit: headCommit,
              uncommittedChanges: status.filter(function(l) { return /^.[MADRC?]/.test(l); }),
              stagedChanges: status.filter(function(l) { return /^[MADRC]/.test(l); }),
              stashCount: stashCount,
              recentCommits: recentCommits,
              activeSessions: CONFIG.activeSessions,
              recentSessions: CONFIG.recentSessions,
              docs: docs,
              openPrs: openPrs,
            }, null, 2),
          }],
        });
      }

      case "openclaw_session_list": {
        var includeNative = toolArgs.include_native !== false;
        var sessions = CONFIG.recentSessions;
        if (!includeNative) {
          sessions = sessions.filter(function(s) { return s.source === "openclaw"; });
        }
        return respond(id, {
          content: [{
            type: "text",
            text: JSON.stringify({
              sessions: sessions,
              total: sessions.length,
              activeCount: CONFIG.activeSessions.length,
            }, null, 2),
          }],
        });
      }

      default:
        return respondError(id, -32601, "Unknown tool: " + toolName);
    }
  }

  if (method === "ping") {
    return respond(id, {});
  }

  // Unknown method
  if (id !== undefined) {
    respondError(id, -32601, "Method not found: " + method);
  }
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const parsed = JSON.parse(line);
    handleRequest(parsed);
  } catch (err) {
    process.stderr.write("[openclaw-bridge] parse error: " + err.message + "\\n");
  }
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the MCP bridge server as a subprocess.
 * Returns a handle with the MCP config for `--mcp-config` and a stop function.
 */
export async function startMcpBridge(
  options: ClaudeCodeSpawnOptions,
  sessionData?: {
    recentSessions?: DiscoveredSession[];
    activeSessions?: Array<{ sessionId: string; repoPath: string }>;
  },
): Promise<McpBridgeHandle> {
  const tmpDir = path.join(os.tmpdir(), "openclaw-mcp-bridge");
  fs.mkdirSync(tmpDir, { recursive: true });

  const bridgeId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scriptPath = path.join(tmpDir, `${bridgeId}.cjs`);
  const announceQueuePath = path.join(tmpDir, `${bridgeId}-announce.ndjson`);

  // Resolve workspace dir for memory search
  const agentId = options.agentId ?? "default";
  const workspaceDir = path.join(os.homedir(), ".openclaw", "agents", agentId);

  const script = generateBridgeScript({
    task: options.task,
    agentId: options.agentId,
    repo: options.repo,
    maxBudgetUsd: options.maxBudgetUsd,
    announceQueuePath,
    workspaceDir,
    recentSessions: sessionData?.recentSessions,
    activeSessions: sessionData?.activeSessions,
  });

  fs.writeFileSync(scriptPath, script, "utf8");

  const mcpConfig: Record<string, unknown> = {
    type: "stdio",
    command: process.execPath,
    args: [scriptPath],
  };

  let stopped = false;

  return {
    mcpConfig,
    announceQueuePath,

    drainAnnouncements(): string[] {
      try {
        if (!fs.existsSync(announceQueuePath)) {
          return [];
        }
        const content = fs.readFileSync(announceQueuePath, "utf8").trim();
        if (!content) {
          return [];
        }
        // Clear the file
        fs.writeFileSync(announceQueuePath, "", "utf8");
        // Parse NDJSON
        const messages: string[] = [];
        for (const line of content.split("\n")) {
          if (!line.trim()) {
            continue;
          }
          try {
            const parsed = JSON.parse(line);
            if (typeof parsed.message === "string") {
              messages.push(parsed.message);
            }
          } catch {
            // Skip malformed lines
          }
        }
        return messages;
      } catch {
        return [];
      }
    },

    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      try {
        fs.unlinkSync(scriptPath);
      } catch {
        // ignore
      }
      try {
        fs.unlinkSync(announceQueuePath);
      } catch {
        // ignore
      }
    },
  };
}
