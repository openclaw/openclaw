/**
 * /claude subcommand handlers. Kept in a separate module so commands.ts
 * stays import-light at slash-command registration time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { peekSharedClaudeAppServerClient } from "./app-server/client.js";
import {
  readClaudeAppServerBinding,
  writeClaudeAppServerBinding,
  type ClaudeAppServerBinding,
} from "./app-server/thread-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function handleHelp(): PluginCommandResult {
  return {
    text: [
      "**/claude** — Inspect and control the Claude app-server harness.",
      "",
      "Subcommands:",
      "  `status`             show shared-client liveness and recent error context",
      "  `version`            report bridge + installed server package versions",
      "  `threads`            list the active session's claude thread binding",
      "  `resume <thread_id>` rotate the active session's binding to a specific thread",
      "",
      "Example: `/claude status`",
    ].join("\n"),
  };
}

export function handleStatus(_ctx: PluginCommandContext): PluginCommandResult {
  const snapshot = peekSharedClaudeAppServerClient();
  const lines = ["**Claude app-server status**", ""];
  if (!snapshot) {
    lines.push("- Shared client: not yet created (no claude turn has run this process)");
    return { text: lines.join("\n") };
  }
  lines.push(`- Shared client: ${snapshot.running ? "running" : "stopped"}`);
  if (snapshot.command) {
    lines.push(`- Command: \`${snapshot.command}\``);
  }
  if (snapshot.pendingRequests > 0) {
    lines.push(`- In-flight requests: ${snapshot.pendingRequests}`);
  }
  if (snapshot.lastError) {
    lines.push(`- Last stderr: \`${snapshot.lastError}\``);
  }
  return { text: lines.join("\n") };
}

export async function handleVersion(_ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const lines = ["**Claude harness versions**", ""];
  const bridge = await readPackageVersion(path.resolve(HERE, "..", "package.json"));
  if (bridge) {
    lines.push(`- Bridge (extensions/claude): ${bridge}`);
  }
  const server = await locateServerPackageVersion();
  lines.push(
    server
      ? `- Server (@openclaw/claude-app-server): ${server}`
      : "- Server (@openclaw/claude-app-server): not installed",
  );
  return { text: lines.join("\n") };
}

export async function handleThreads(ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const sessionFile = ctx.sessionFile;
  if (!sessionFile) {
    return {
      text: "**Claude threads**\n\nNo session file is bound to this invocation; run `/claude threads` from an active agent session.",
    };
  }
  const binding = await safeReadBinding(sessionFile);
  if (!binding) {
    return {
      text: `**Claude threads**\n\nNo claude binding sidecar at \`${path.basename(sessionFile)}.claude-binding.json\`. A new thread will start on the next turn.`,
    };
  }
  return { text: formatBinding(sessionFile, binding) };
}

export async function handleResume(
  ctx: PluginCommandContext,
  rest: string,
): Promise<PluginCommandResult> {
  const sessionFile = ctx.sessionFile;
  if (!sessionFile) {
    return {
      text: "**/claude resume**\n\nNo session file is bound to this invocation; run from an active agent session.",
    };
  }
  const targetThreadId = rest.trim();
  if (!targetThreadId) {
    return {
      text: "**/claude resume**\n\nUsage: `/claude resume <thread_id>` — rotates the current session's claude binding to the given thread on the next turn.",
    };
  }
  const existing = await safeReadBinding(sessionFile);
  const now = Date.now();
  const next: ClaudeAppServerBinding = existing
    ? { ...existing, threadId: targetThreadId, updatedAt: now }
    : {
        schemaVersion: 1,
        threadId: targetThreadId,
        cwd: process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
  await writeClaudeAppServerBinding(sessionFile, next);
  return {
    text: `**/claude resume**\n\nRebound session to thread \`${targetThreadId}\`. Next turn will issue \`thread/resume\` instead of \`thread/start\`.`,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

async function safeReadBinding(sessionFile: string): Promise<ClaudeAppServerBinding | null> {
  try {
    return await readClaudeAppServerBinding(sessionFile);
  } catch {
    return null;
  }
}

function formatBinding(sessionFile: string, b: ClaudeAppServerBinding): string {
  const lines = ["**Claude threads**", ""];
  lines.push(`- Session file: \`${path.basename(sessionFile)}\``);
  lines.push(`- Thread ID: \`${b.threadId}\``);
  if (b.model) {
    const providerSuffix = b.modelProvider ? ` (${b.modelProvider})` : "";
    lines.push(`- Model: ${b.model}${providerSuffix}`);
  }
  lines.push(`- cwd: \`${b.cwd}\``);
  if (b.approvalPolicy) {
    lines.push(`- Approval policy: ${b.approvalPolicy}`);
  }
  if (b.sandbox) {
    lines.push(`- Sandbox: ${b.sandbox.type}`);
  }
  if (b.dynamicToolsFingerprint) {
    lines.push(`- Dynamic tools fingerprint: \`${b.dynamicToolsFingerprint.slice(0, 16)}…\``);
  }
  lines.push(`- Updated: ${new Date(b.updatedAt).toISOString()}`);
  return lines.join("\n");
}

async function readPackageVersion(packageJsonPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(packageJsonPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function locateServerPackageVersion(): Promise<string | null> {
  const candidates = [
    path.resolve(
      HERE,
      "..",
      "..",
      "..",
      "node_modules",
      "@openclaw",
      "claude-app-server",
      "package.json",
    ),
    path.resolve(HERE, "..", "node_modules", "@openclaw", "claude-app-server", "package.json"),
  ];
  for (const candidate of candidates) {
    const version = await readPackageVersion(candidate);
    if (version) {
      return version;
    }
  }
  return null;
}
