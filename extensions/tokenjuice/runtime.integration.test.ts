import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { clearRuleCache, loadRules } from "tokenjuice";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { createTokenjuiceAgentToolResultMiddleware } from "./tool-result-middleware.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

beforeAll(() => {
  vi.stubEnv("TOKENJUICE_STATS", "0");
  vi.stubEnv("TOKENJUICE_NO_OMISSION", "1");
});
afterAll(() => {
  clearRuleCache();
  vi.unstubAllEnvs();
});

it("bounds compiled rules across shell worktrees without evicting for unrelated results", async () => {
  const middleware = createTokenjuiceAgentToolResultMiddleware({ warn: vi.fn() });
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
  for (let worktree = 1; worktree <= 128; worktree++) {
    await middleware({ ...event(worktree), toolName: "read" }, { runtime: "openclaw" });
  }
  expect(await loadRules(options)).toBe(rules);
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

function packagedRunner() {
  const captured = capturePluginRegistration({
    id: "tokenjuice",
    contracts: manifest.contracts,
    register: plugin.register,
  });
  return createAgentToolResultMiddlewareRunner({ runtime: "openclaw" }, [
    captured.agentToolResultMiddlewares[0]!.handler,
  ]);
}

it("preserves the original result when the packaged reducer hits a malformed project rule", async () => {
  const workdir = tempDirs.make("tokenjuice-malformed-rule-");
  const rules = path.join(workdir, ".tokenjuice", "rules");
  await mkdir(rules, { recursive: true });
  await writeFile(path.join(rules, "malformed.json"), '{"unclosed":');
  const original = {
    content: [{ type: "text" as const, text: raw }],
    details: { status: "completed", exitCode: 0, aggregated: raw, cwd: workdir },
  };
  const actual = await packagedRunner().applyToolResultMiddleware({
    toolCallId: "tokenjuice-malformed-rule",
    toolName: "exec",
    args: { command: "git status", workdir },
    result: original,
    isError: false,
  });
  expect(actual).toBe(original);
});

it.each([
  {
    label: "timeout guidance",
    suffix: "Command timed out. Verify the resulting state before retrying.",
    details: { status: "failed", exitCode: null, timedOut: true, exitReason: "overall-timeout" },
  },
  {
    label: "spill link",
    suffix: "[full output: /workspace/tokenjuice/full-output.txt]",
    details: {
      status: "completed",
      exitCode: 0,
      fullOutputPath: "/workspace/tokenjuice/full-output.txt",
    },
  },
])("keeps the host's original $label out of the packaged reducer", async ({ details, suffix }) => {
  const original = {
    content: [{ type: "text" as const, text: raw + suffix }],
    details: { ...details, aggregated: raw },
  };
  const actual = await packagedRunner().applyToolResultMiddleware({
    toolCallId: "tokenjuice-host-guidance",
    toolName: "exec",
    args: { command: "git status", workdir: "/workspace/tokenjuice" },
    result: original,
    isError: details.status === "failed",
  });
  expect(actual).toBe(original);
});

it("runs the packaged reducer while preserving exact reads and Code Mode results", async () => {
  const runner = packagedRunner();
  const event = (command: string): AgentToolResultMiddlewareEvent => ({
    toolCallId: "tokenjuice-package-smoke",
    toolName: "exec",
    args: { command, workdir: "/workspace/tokenjuice" },
    result: {
      content: [{ type: "text", text: raw }],
      details: {
        status: "completed",
        exitCode: 0,
        aggregated: raw,
      },
    },
    isError: false,
  });
  const expectedCompacted =
    "Changes not staged:\nM: src/alpha.ts\nM: src/beta.ts\n\n[tokenjuice compacted bash output]";
  for (const toolName of ["exec", "bash", "gateway_exec", "node_exec"]) {
    const compacted = await runner.applyToolResultMiddleware({ ...event("git status"), toolName });
    expect(compacted.content, toolName).toEqual([{ type: "text", text: expectedCompacted }]);
    expect(compacted.details, toolName).toMatchObject({
      status: "completed",
      exitCode: 0,
      aggregated: expectedCompacted,
      tokenjuice: { compacted: true },
    });
  }
  const exactRead = event("cat README.md");
  expect(await runner.applyToolResultMiddleware(exactRead)).toEqual(exactRead.result);

  const code = 'return { records: await catalog.search("schema") };';
  const codeMode = event(code);
  codeMode.args.code = code;
  const text = JSON.stringify(
    { records: Array.from({ length: 250 }, (_, id) => ({ id, value: `record-${id}` })) },
    null,
    2,
  );
  codeMode.result = {
    content: [{ type: "text", text }],
    details: { status: "completed", exitCode: 0, aggregated: text },
  };
  const expected = structuredClone(codeMode.result);
  expect(await runner.applyToolResultMiddleware(codeMode)).toEqual(expected);
});
