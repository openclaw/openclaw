import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearRuleCache, loadRules } from "tokenjuice";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

beforeAll(() => {
  vi.stubEnv("TOKENJUICE_STATS", "0");
  vi.stubEnv("TOKENJUICE_NO_OMISSION", "1");
});
afterAll(() => {
  clearRuleCache();
  vi.unstubAllEnvs();
});

it("bounds compiled rules across worktree churn without clearing every result", async () => {
  const middleware = createTokenjuiceAgentToolResultMiddleware();
  const event = (worktree: number, context = 0): AgentToolResultMiddlewareEvent => ({
    toolCallId: `rule-cache-${worktree}`,
    toolName: "exec",
    cwd: `/synthetic-tokenjuice/session-${context}`,
    args: { command: "git status", workdir: `/synthetic-tokenjuice/worktree-${worktree}` },
    result: {
      content: [
        {
          type: "text",
          text: "On branch main\n\nChanges not staged for commit:\n\tmodified:   src/a.ts\n",
        },
      ],
      details: { status: "completed", exitCode: 0, cwd: `/synthetic/${context}` },
    },
  });
  const first = await middleware(event(0), { runtime: "openclaw" });
  const options = { cwd: "/synthetic-tokenjuice/worktree-0" };
  const rules = await loadRules(options);
  for (let turn = 0; turn < 256; turn++) {
    await middleware(event(turn % 2, turn), { runtime: "openclaw" });
  }
  expect(await loadRules(options)).toBe(rules);
  for (let worktree = 1; worktree < 128; worktree++) {
    expect(await middleware(event(worktree), { runtime: "openclaw" })).toEqual(first);
  }
  const reloaded = await loadRules(options);
  expect(reloaded).not.toBe(rules);
  expect(reloaded).toEqual(rules);
});

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
