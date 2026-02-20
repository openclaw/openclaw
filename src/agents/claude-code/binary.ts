/**
 * Resolve the `claude` CLI binary path.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Resolves the Claude Code CLI binary.
 *
 * Resolution order:
 * 1. Explicit path from config (`binaryPath`)
 * 2. `which claude` from PATH
 * 3. Throw with install instructions
 */
export function resolveClaudeBinary(binaryPath?: string | null): string {
  // 1. Explicit path from config
  if (binaryPath) {
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Claude Code binary not found at configured path: ${binaryPath}`);
    }
    return binaryPath;
  }

  // 2. Resolve from PATH
  try {
    const resolved = execFileSync("which", ["claude"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (resolved) {
      return resolved;
    }
  } catch {
    // Fall through on Windows or missing `which`
  }

  // Windows fallback
  if (process.platform === "win32") {
    try {
      const resolved = execFileSync("where", ["claude"], {
        encoding: "utf8",
        timeout: 5_000,
      })
        .trim()
        .split(/\r?\n/)[0];
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall through
    }
  }

  // 3. Fail with helpful message
  throw new Error(
    "Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code\n" +
      "Or set agents.defaults.subagents.claudeCode.binaryPath in openclaw.json",
  );
}
