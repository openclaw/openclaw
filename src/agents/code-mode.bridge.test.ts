import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { execSchema } from "./bash-tools.schemas.js";
import { createGatedToolFactory } from "./code-mode-concurrency.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  expectToolCalls,
  expectCompleted,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function bridge(targets: AnyAgentTool[], timeoutMs = 10_000, awaitResults?: boolean) {
  const h = createCodeModeHarness({ codeMode: { timeoutMs } });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  return async (code: string, signal?: AbortSignal) =>
    resultDetails(await h.tools[0]!.execute("bridge", { code, awaitResults }, signal));
}

const mockClock = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
const tool = (name: string, execute: AnyAgentTool["execute"]) =>
  pluginToolWithExecute(name, name, execute);
const gatedTool = createGatedToolFactory(tool);

afterEach(async () => {
  vi.useRealTimers();
  try {
    expect(testing.activeRuns.size).toBe(0);
  } finally {
    await resetCodeModeTestState();
  }
});

it.each([false, true])("drains settled combinators (failure=%s)", async (failure) => {
  mockClock();
  const events: string[] = [];
  const gate = gatedTool("slow", "slow", events, { winner: "slow" });
  const slow = gate.tool;
  const fast = tool("fast", async () => {
    if (failure) {
      events.push("fast:wait");
    }
    await gate.started.promise;
    events.push("fast:settled");
    if (failure) {
      throw new Error("fast failure");
    }
    return jsonResult({ winner: "fast" });
  });
  const release = tool("release", async () => {
    events.push("slow:release");
    gate.release.resolve();
    return jsonResult({ released: true });
  });
  const run = bridge([slow, fast, release]);
  const details = await run(
    failure
      ? 'try { await Promise.all([fast({}), slow({})]); return "unexpected success"; } catch (error) { void release({}); return error.message; }'
      : "const value = await Promise.race([Promise.all([slow({})]), fast({})]); void release({}); return value;",
  );
  expectCompleted(details, failure ? "fast failure" : { winner: "fast" });
  expectToolCalls(1, slow, fast, release);
  const settled = ["slow:start", "fast:settled", "slow:release", "slow:done"];
  expect(events).toEqual(failure ? ["fast:wait", ...settled] : settled);
  expect(gate.state.aborted).toBe(false);
});

it.each([false, true])("exec timing/detachment (%s)", async (awaitResults) => {
  mockClock();
  const shell = fakeTool("exec", "Run shell");
  shell.execute = async (_id, input) => jsonResult(input);
  shell.parameters = execSchema;
  const run = bridge([shell], 10_000, awaitResults);
  const details = await run(`return [
      await exec({ command: "default" }),
      await exec({ command: "explicit", yieldMs: 4_000 }),
      await exec({ command: "background", background: true }),
    ];`);
  expectCompleted(details, [
    { command: "default", ...(awaitResults ? { awaitResults: true } : { yieldMs: 9_500 }) },
    { command: "explicit", yieldMs: 4_000, ...(awaitResults ? { awaitResults: true } : {}) },
    { command: "background", background: true },
  ]);
});

it("bounds nested exec yield by the shared remaining deadline", async () => {
  mockClock();
  const consume = tool("consume", async () => {
    vi.advanceTimersByTime(9_600);
    return jsonResult({ consumed: true });
  });
  const shell = tool("exec", async (_id, input) => jsonResult(input));
  shell.parameters = Type.Object({
    command: Type.String(),
    yieldMs: Type.Optional(Type.Number()),
    background: Type.Optional(Type.Boolean()),
  });
  expectCompleted(
    await bridge([consume, shell])('await consume({}); return await exec({ command: "late" });'),
    { command: "late", yieldMs: 1 },
  );
  expectToolCalls(1, consume, shell);
});

it.each([true, false])("aborts without parking a run (beforeStart=%s)", async (beforeStart) => {
  const stuck = tool("stuck", async () => await new Promise<never>(() => {}));
  const controller = new AbortController();
  if (beforeStart) {
    controller.abort();
  }
  const abortTimer = beforeStart ? undefined : setTimeout(() => controller.abort(), 200);
  const startedAt = Date.now();
  try {
    const code = beforeStart ? "await stuck({}); return 'done';" : "while (true) {}";
    expect(await bridge([stuck], 30_000)(code, controller.signal)).toMatchObject({
      status: "failed",
      error: "code mode execution aborted",
      code: "aborted",
    });
  } finally {
    clearTimeout(abortTimer);
  }
  if (!beforeStart) {
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }
  expect(stuck.execute).not.toHaveBeenCalled();
});

it("surfaces policy blocks as guest call errors for declared outputs", async () => {
  const target = tool("blocked", async () => buildBlockedToolResult({ reason: "policy" }));
  target.outputSchema = Type.Array(
    Type.Object({ id: Type.String() }, { additionalProperties: false }),
  );
  const result = await bridge([target])(
    "try { const rows = await blocked({}); return rows.map(row => row.id); } catch (error) { return error.message; }",
  );
  expectCompleted(result, expect.stringContaining("was blocked before execution: policy"));
});
