/**
 * /claude subcommand handlers. Kept in a separate module so commands.ts
 * stays import-light at slash-command registration time.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { peekSharedClaudeAppServerClient } from "./app-server/client.js";
import { resolveManagedClaudeBridgeVersion } from "./app-server/managed-binary.js";
import {
  readClaudeAppServerBinding,
  writeClaudeAppServerBinding,
  type ClaudeAppServerBinding,
} from "./app-server/thread-store.js";
import { compareClaudeBridgeVersions, MIN_CLAUDE_BRIDGE_VERSION } from "./app-server/version.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function handleHelp(): PluginCommandResult {
  return {
    text: [
      "**/claude** — Inspect and control the Claude app-server harness.",
      "",
      "Subcommands:",
      "  `status`             show shared-client liveness and recent error context",
      "  `version`            report plugin, running, installed, and required bridge versions",
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
  if (snapshot.runningVersion) {
    lines.push(`- Running version: ${snapshot.runningVersion}`);
  }
  if (snapshot.pendingRequests > 0) {
    lines.push(`- In-flight requests: ${snapshot.pendingRequests}`);
  }
  const bundled = resolveManagedClaudeBridgeVersion();
  if (
    snapshot.runningVersion &&
    bundled &&
    compareClaudeBridgeVersions(snapshot.runningVersion, bundled) < 0
  ) {
    lines.push(
      `- Update pending: running ${snapshot.runningVersion}, bundled ${bundled} (restart the gateway to apply)`,
    );
  }
  if (snapshot.lastError) {
    lines.push(`- Last stderr: \`${snapshot.lastError}\``);
  }
  return { text: lines.join("\n") };
}

export async function handleVersion(_ctx: PluginCommandContext): Promise<PluginCommandResult> {
  const lines = ["**Claude harness versions**", ""];
  const plugin = await readPackageVersion(path.resolve(HERE, "..", "package.json"));
  if (plugin) {
    lines.push(`- Plugin (extensions/claude): ${plugin}`);
  }
  lines.push(`- Minimum bridge required: ${MIN_CLAUDE_BRIDGE_VERSION}`);

  const bundled = resolveManagedClaudeBridgeVersion();
  lines.push(
    bundled
      ? `- Bundled bridge (managed): ${bundled}`
      : "- Bundled bridge (managed): not found — reinstall OpenClaw or run `pnpm install`",
  );

  const snapshot = peekSharedClaudeAppServerClient();
  const running = snapshot?.running ? snapshot.runningVersion : undefined;
  lines.push(`- Running bridge (spawned): ${running ?? "not running"}`);

  if (running && compareClaudeBridgeVersions(running, MIN_CLAUDE_BRIDGE_VERSION) < 0) {
    lines.push(
      "- ⚠ Running bridge is below the required minimum; reinstall the bridge and restart the gateway.",
    );
  } else if (running && bundled && compareClaudeBridgeVersions(running, bundled) < 0) {
    lines.push("- Update pending: a newer bridge is bundled; restart the gateway to apply.");
  }
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
