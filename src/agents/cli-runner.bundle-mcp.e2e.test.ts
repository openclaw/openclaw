import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv } from "../test-utils/env.js";
import {
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeFakeClaudeCli,
} from "./bundle-mcp.test-harness.js";

vi.mock("./cli-runner/helpers.js", async () => {
  const original =
    await vi.importActual<typeof import("./cli-runner/helpers.js")>("./cli-runner/helpers.js");
  return {
    ...original,
    // This e2e only validates bundle MCP wiring into the spawned CLI backend.
    // Stub the large prompt-construction path so cold Vitest workers do not
    // time out before the actual MCP roundtrip runs.
    buildSystemPrompt: () => "Bundle MCP e2e test prompt.",
  };
});

// This e2e spins a real stdio MCP server plus a spawned CLI process, which is
// notably slower under Docker and cold Vitest imports.
const E2E_TIMEOUT_MS = 40_000;

describe("runCliAgent bundle MCP e2e", () => {
  it(
    "routes enabled bundle MCP config into a registered CLI backend and executes the tool",
    { timeout: E2E_TIMEOUT_MS },
    async () => {
      const { runCliAgent } = await import("./cli-runner.js");
      const envSnapshot = captureEnv(["HOME"]);
      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-bundle-mcp-"));
      process.env.HOME = tempHome;

      const workspaceDir = path.join(tempHome, "workspace");
      const sessionFile = path.join(tempHome, "session.jsonl");
      const binDir = path.join(tempHome, "bin");
      const serverScriptPath = path.join(tempHome, "mcp", "bundle-probe.mjs");
      const fakeClaudePath = path.join(binDir, "fake-claude.mjs");
      const pluginRoot = path.join(tempHome, ".openclaw", "extensions", "bundle-probe");
      const registry = createEmptyPluginRegistry();
      registry.cliBackends = [
        {
          pluginId: "bundle-cli-test",
          source: "test",
          backend: {
            id: "bundle-cli",
            bundleMcp: true,
            config: {
              command: "node",
              args: [fakeClaudePath],
              output: "jsonl",
              input: "arg",
              sessionArg: "--session-id",
              sessionIdFields: ["session_id"],
              clearEnv: [],
            },
          },
        },
      ];
      setActivePluginRegistry(registry);
      await fs.mkdir(workspaceDir, { recursive: true });
      await writeBundleProbeMcpServer(serverScriptPath);
      await writeFakeClaudeCli(fakeClaudePath);
      await writeClaudeBundle({ pluginRoot, serverScriptPath });

      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: workspaceDir,
          },
        },
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      };

      try {
        const result = await runCliAgent({
          sessionId: "session:test",
          sessionFile,
          workspaceDir,
          config,
          prompt: "Use your configured MCP tools and report the bundle probe text.",
          provider: "bundle-cli",
          model: "test-bundle",
          timeoutMs: 10_000,
          runId: "bundle-mcp-e2e",
        });

        expect(result.payloads?.[0]?.text).toContain("BUNDLE MCP OK FROM-BUNDLE");
        expect(result.meta.agentMeta?.sessionId.length ?? 0).toBeGreaterThan(0);
      } finally {
        await fs.rm(tempHome, { recursive: true, force: true });
        envSnapshot.restore();
      }
    },
  );
});
