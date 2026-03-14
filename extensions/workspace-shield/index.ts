/**
 * Workspace Shield
 *
 * Protects critical workspace files from accidental agent writes.
 * Uses the before_tool_call hook to intercept Write and Edit operations
 * targeting protected files and blocks them with a clear explanation.
 *
 * Configuration:
 *   protectedFiles    — explicit file paths to protect
 *   protectedPatterns — glob patterns for protected files
 *   allowReads        — whether Read is allowed on protected files (default: true)
 *   logViolations     — whether to log blocked operations (default: true)
 *   violationsPath    — path for the violations log file
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import fs from "node:fs";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

interface PluginConfig {
  protectedFiles?: string[];
  protectedPatterns?: string[];
  allowReads?: boolean;
  logViolations?: boolean;
  violationsPath?: string;
}

interface ViolationRecord {
  timestamp: string;
  tool: string;
  file: string;
  action: "blocked" | "logged";
  reason: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Convert a simple glob pattern to a regex. Supports * and ** wildcards. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Extract the file path from a tool call's parameters. */
function extractFilePath(toolName: string, params: Record<string, unknown>): string | null {
  // The Write, Edit, and Read tools accept both `path` and `file_path`
  const raw = params.file_path ?? params.path ?? params.filePath;
  return typeof raw === "string" ? raw : null;
}

/** Resolve a path relative to the workspace, handling absolute paths. */
function toRelative(filePath: string, workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir, filePath);
  if (resolved.startsWith(workspaceDir + path.sep) || resolved === workspaceDir) {
    return path.relative(workspaceDir, resolved);
  }
  // For absolute paths outside workspace, return the original
  return filePath;
}

// ── Plugin ─────────────────────────────────────────────────────────────

export default function register(api: OpenClawPluginApi) {
  const config = (api.config ?? {}) as PluginConfig;
  const workspaceDir = api.workspaceDir ?? process.cwd();

  const protectedFiles = new Set(
    (config.protectedFiles ?? []).map((f) => f.trim()).filter(Boolean),
  );
  const protectedPatterns = (config.protectedPatterns ?? [])
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globToRegex);

  const allowReads = config.allowReads !== false;
  const logViolations = config.logViolations !== false;
  const violationsPath = path.resolve(
    workspaceDir,
    config.violationsPath ?? "shield-violations.jsonl",
  );

  // Write tools that modify files
  const WRITE_TOOLS = new Set(["Write", "Edit"]);
  const READ_TOOLS = new Set(["Read"]);

  function isProtected(relativePath: string): boolean {
    if (protectedFiles.has(relativePath)) {
      return true;
    }
    for (const regex of protectedPatterns) {
      if (regex.test(relativePath)) {
        return true;
      }
    }
    return false;
  }

  function logViolation(record: ViolationRecord): void {
    if (!logViolations) return;
    try {
      const dir = path.dirname(violationsPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(violationsPath, JSON.stringify(record) + "\n");
    } catch {
      // Non-fatal
    }
  }

  if (protectedFiles.size === 0 && protectedPatterns.length === 0) {
    api.logger.info(
      "[workspace-shield] No protected files or patterns configured. " +
        "Add protectedFiles or protectedPatterns to your plugin config.",
    );
    return;
  }

  api.logger.info(
    `[workspace-shield] Protecting ${protectedFiles.size} files + ${protectedPatterns.length} patterns`,
  );

  // ── Hook: before_tool_call ──────────────────────────────────────────

  api.on(
    "before_tool_call",
    (event: { toolName: string; params: Record<string, unknown> }) => {
      const { toolName, params } = event;

      const isWrite = WRITE_TOOLS.has(toolName);
      const isRead = READ_TOOLS.has(toolName);

      if (!isWrite && !isRead) return {};

      const filePath = extractFilePath(toolName, params);
      if (!filePath) return {};

      const relativePath = toRelative(filePath, workspaceDir);

      if (!isProtected(relativePath)) return {};

      if (isRead && allowReads) {
        // Log the read but allow it
        logViolation({
          timestamp: new Date().toISOString(),
          tool: toolName,
          file: relativePath,
          action: "logged",
          reason: "read allowed on protected file",
        });
        return {};
      }

      // Block the operation
      logViolation({
        timestamp: new Date().toISOString(),
        tool: toolName,
        file: relativePath,
        action: "blocked",
        reason: `${toolName} blocked on protected file`,
      });

      const action = isWrite ? "modify" : "read";
      return {
        block: true,
        blockReason:
          `🛡️ **Workspace Shield**: \`${relativePath}\` is a protected file. ` +
          `${toolName} operations that ${action} this file are blocked. ` +
          `If you need to update this file, ask the user to do it manually ` +
          `or have them temporarily disable protection in the plugin config.`,
      };
    },
  );
}
