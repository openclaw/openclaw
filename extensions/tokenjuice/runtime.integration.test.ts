import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

beforeAll(() => {
  vi.stubEnv("TOKENJUICE_STATS", "0");
  vi.stubEnv("TOKENJUICE_NO_OMISSION", "1");
});
afterAll(() => vi.unstubAllEnvs());

it("runs the packaged reducer while preserving exact file-read output", async () => {
  const captured = capturePluginRegistration({
    id: "tokenjuice",
    contracts: manifest.contracts,
    register: plugin.register,
  });
  const runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
    captured.agentToolResultMiddlewares[0]!.handler,
  ]);
  const raw = [
    "On branch feature/fixture",
    "",
    "Changes not staged for commit:",
    "\tmodified:   src/alpha.ts",
    "\tmodified:   src/beta.ts",
    "",
    "no changes added to commit",
    "",
    "",
  ].join("\r\n");
  const event = (command: string): AgentToolResultMiddlewareEvent => ({
    toolCallId: "tokenjuice-package-smoke",
    toolName: "exec",
    args: { command, workdir: "/workspace/tokenjuice" },
    result: {
      content: [{ type: "text", text: raw }],
      details: { status: "completed", exitCode: 0 },
    },
    isError: false,
  });
  const compacted = await runner.applyToolResultMiddleware(event("git status"));
  expect(compacted.content).toEqual([
    {
      type: "text",
      text: "Changes not staged:\nM: src/alpha.ts\nM: src/beta.ts\n\n[tokenjuice compacted bash output]",
    },
  ]);
  const preserved = await runner.applyToolResultMiddleware(event("cat README.md"));
  expect(preserved.content).toEqual([{ type: "text", text: raw }]);
});
