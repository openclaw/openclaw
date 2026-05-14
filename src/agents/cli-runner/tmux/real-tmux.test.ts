import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeTmuxCliRun } from "./execute.js";
import { TmuxSessionManager } from "./manager.js";

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("executeTmuxCliRun with real tmux", () => {
  const tempDirs: string[] = [];
  const manager = new TmuxSessionManager();

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      try {
        for (const sessionName of await fs.readdir(dir)) {
          await manager.killSession(sessionName);
        }
      } catch {
        // Best-effort cleanup for tests skipped before runtime dirs exist.
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  (hasTmux() ? it : it.skip)(
    "confirms the trust prompt, passes OpenClaw env, and does not replay prompt echo",
    async () => {
      const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-real-tmux-test-"));
      tempDirs.push(runtimeDir);
      const fakeClaude = path.join(runtimeDir, "fake-claude.mjs");
      await fs.writeFile(
        fakeClaude,
        `#!/usr/bin/env node
process.stdout.write("Quick safety check: Is this a project you created or one you trust?\\n");
process.stdout.write("❯ 1. Yes, I trust this folder\\n");
process.stdout.write("Enter to confirm · Esc to cancel\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
let trusted = false;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) {
    if (!trusted) {
      trusted = true;
      buffer = "";
      process.stdout.write("Claude Code v2.1.140\\n");
      return;
    }
    process.stdout.write("Hello from fake Claude MEMORY=" + process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY + "\\n");
    buffer = "";
  }
});
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );

      const output = await executeTmuxCliRun({
        backend: {
          command: process.execPath,
          args: [fakeClaude, "-p", "--bare"],
          modelArg: "--model",
          sessionArg: "--session-id",
          execution: {
            mode: "tmux",
            tmux: {
              runtimeDir,
              hookMode: "off",
              startupTimeoutMs: 3_000,
              turnIdleMs: 300,
              turnTimeoutMs: 5_000,
            },
          },
        },
        backendId: "claude-cli",
        workspaceDir: runtimeDir,
        sessionId: "openclaw-session",
        cliSessionId: "00000000-0000-4000-8000-000000000000",
        runId: "run-real",
        modelId: "sonnet",
        systemPrompt: "system",
        prompt: "hello",
        timeoutMs: 5_000,
        env: {},
      });

      expect(output.text).toContain("Hello from fake Claude MEMORY=1");
      expect(output.text).not.toContain("hello");
      expect(output.sessionId).toBe("00000000-0000-4000-8000-000000000000");
    },
  );
});
