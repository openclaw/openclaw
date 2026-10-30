import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createCatalogCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCompleted,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const queuedValues = Array.from({ length: 20 }, (_, i) => String(i));

function makeProbe(execute: AnyAgentTool["execute"] = async (_id, input) => jsonResult(input)) {
  return pluginToolWithExecute("probe", "Backpressure probe", execute);
}

function harness(headless: boolean, limit: number, tool: AnyAgentTool) {
  const { ctx, tools } = createCodeModeHarness({ codeMode: { maxPendingToolCalls: limit } });
  applyCodeModeCatalog({ ...ctx, tools: [...tools, tool] });
  return async (
    code: string,
    signal?: AbortSignal,
    maxToolCalls = 200,
  ): Promise<Record<string, unknown>> =>
    headless
      ? await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([tool], { codeMode: { maxPendingToolCalls: limit } }),
          code,
          maxToolCalls,
          signal,
        })
      : resultDetails(
          await expectDefined(tools[0], "exec tool").execute("backpressure-exec", { code }, signal),
        );
}

afterEach(async () => {
  try {
    expect(testing.activeRuns.size).toBe(0);
  } finally {
    await resetCodeModeTestState();
  }
});

it("drains 144 calls inline with 16 slots", async () => {
  const limit = 16;
  const count = 144;
  const started = createDeferred();
  const release = createDeferred();
  const inputs: unknown[] = [];
  let active = 0;
  let maximum = 0;
  const tool = makeProbe(async (_id, input) => {
    inputs.push(input);
    active++;
    maximum = Math.max(maximum, active);
    if (active === limit) {
      started.resolve();
    }
    try {
      await release.promise;
      return jsonResult(input);
    } finally {
      active--;
    }
  });
  tool.executionMode = "parallel";
  const run = harness(false, limit, tool);
  const execution = run(
    `const calls = Array.from({ length: ${count} }, (_, i) => probe({ value: String(i) }));` +
      'const rows = await Promise.all(calls); return await probe({ value: rows.map(r => r.value).join(",") });',
  );
  try {
    await Promise.race([started.promise, execution]);
    expect(active).toBe(limit);
  } finally {
    release.resolve();
    await execution;
  }
  const expected = Array.from({ length: count }, (_, i) => ({ value: String(i) }));
  expectCompleted(await execution, { value: expected.map((row) => row.value).join(",") });
  expect(inputs).toEqual([...expected, { value: expected.map((row) => row.value).join(",") }]);
  expect({ maximum, active }).toEqual({ maximum: limit, active: 0 });
});

it("rejects caught queue overflow and admits a fresh run", async () => {
  const tool = makeProbe(async () => jsonResult({}));
  const run = harness(false, 2, tool);
  const fanout = "for (let i = 0; i < 131; i++) void probe({ value: String(i) });";
  const result = await run("try {" + fanout + '} catch (e) { text(e.message); } return "caught";');
  expect(result).toMatchObject({ status: "failed", code: "invalid_input" });
  expect(result.error).toContain("queue limit exceeded");
  expect(result.error).toContain("Await smaller batches");
  expect(tool.execute).not.toHaveBeenCalled();
  expect(result.output).toEqual([
    { type: "text", text: expect.stringContaining("queue limit exceeded") },
  ]);
  expect((await run('return await probe({ value: "fresh" });')).status).toBe("completed");
  expect(tool.execute).toHaveBeenCalledOnce();
});

it("cancels queued timers without admitting them and drains live timer callbacks", async () => {
  const tool = makeProbe();
  const run = harness(false, 1, tool);
  const result = await run(
    'const first = probe({ value: "first" });' +
      'for (let i = 0; i < 160; i++) { const timer = setTimeout(() => { throw new Error("canceled timer fired"); }, 60000); clearTimeout(timer); }' +
      "const timers = Array.from({ length: 20 }, (_, i) => new Promise(resolve => setTimeout(async () => resolve(await probe({ value: String(i) })), 0)));" +
      "await first; return (await Promise.all(timers)).map(row => row.value);",
  );
  expectCompleted(result, queuedValues);
  expect(tool.execute).toHaveBeenCalledTimes(21);
});

it.each([false, true])("drops queued calls on abort (headless=%s)", async (headless) => {
  const started = createDeferred<AbortSignal | undefined>();
  const release = createDeferred();
  const controller = new AbortController();
  const tool = makeProbe(async (_id, _input, signal) => {
    started.resolve(signal);
    await release.promise;
    return jsonResult({});
  });
  const run = harness(headless, 1, tool);
  const execution = run(
    "return await Promise.all(Array.from({ length: 20 }, (_, i) => probe({ value: String(i) })));",
    controller.signal,
  );
  try {
    await Promise.race([started.promise, execution]);
    expect(tool.execute).toHaveBeenCalledOnce();
    controller.abort();
    expect(await execution).toMatchObject({ status: "failed", code: "aborted" });
    expect((await started.promise)?.aborted).toBe(true);
  } finally {
    controller.abort();
    release.resolve();
    await execution;
  }
  expect(tool.execute).toHaveBeenCalledOnce();
});
it("carries queued calls through a public exec/wait without replaying the prefix", async () => {
  const probe = makeProbe();
  const { run, resume } = createCatalogCodeModeHarness([probe]);
  const parked = await run(
    'const pause = yield_control("pause"); const calls = Array.from({ length: 20 }, (_, i) => probe({ value: String(i) })); await pause; return await Promise.all(calls);',
    "park",
  );
  expect(parked.status).toBe("waiting");
  expect(testing.activeRuns.size).toBe(1);
  const result = await resume(parked);
  expectCompleted(
    result,
    queuedValues.map((value) => ({ value })),
  );
  expect(probe.execute).toHaveBeenCalledTimes(20);
});

it("keeps the headless total tool-count guard while draining queued calls", async () => {
  const tool = makeProbe(async () => jsonResult({}));
  const result = await harness(true, 2, tool)(
    "return await Promise.all(Array.from({ length: 20 }, () => probe({})));",
    undefined,
    5,
  );
  expect(result).toMatchObject({ status: "failed", code: "tool_budget_exceeded" });
  expect(tool.execute).toHaveBeenCalledTimes(4);
});
