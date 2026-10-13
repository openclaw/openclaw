import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  applyCodeModeCatalog,
  createCodeModeTools,
  runCodeModeScriptHeadless,
} from "./code-mode.js";
import {
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

// Both public entry points use the real selected executor and normal tool executor.
function harness(headless: boolean, limit: number, tool: AnyAgentTool) {
  const config: OpenClawConfig = {
    tools: { codeMode: { enabled: true, maxPendingToolCalls: limit } },
  };
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "backpressure-session",
    sessionKey: "agent:main:backpressure",
    runId: "backpressure-run",
    catalogRef: createToolSearchCatalogRef(),
  };
  const tools = createCodeModeTools(ctx);
  applyCodeModeCatalog({ ...ctx, tools: [...tools, tool] });
  return async (
    code: string,
    signal?: AbortSignal,
    maxToolCalls = 200,
  ): Promise<Record<string, unknown>> => {
    if (headless) {
      return await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([tool]),
        code,
        overrides: { maxPendingToolCalls: limit },
        maxToolCalls,
        signal,
      });
    }
    return resultDetails(
      await expectDefined(tools[0], "exec tool").execute("backpressure-exec", { code }, signal),
    );
  };
}

afterEach(async () => {
  try {
    expect(testing.activeRuns.size).toBe(0);
  } finally {
    await resetCodeModeTestState();
  }
});

describe("ordinary bridge backpressure", () => {
  it.each([{ limit: 16, count: 144 }])(
    "drains $count calls inline with $limit slots",
    async ({ limit, count }) => {
      const started = createDeferred();
      const release = createDeferred();
      const inputs: unknown[] = [];
      let active = 0;
      let maximum = 0;
      const tool = pluginToolWithExecute("probe", "Backpressure probe", async (_id, input) => {
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
        "const calls = Array.from({ length: " +
          count +
          " }, (_, i) => probe({ value: String(i) }));" +
          'const rows = await Promise.all(calls); return await probe({ value: rows.map(r => r.value).join(",") });',
      );
      try {
        await Promise.race([started.promise, execution]);
        expect(active).toBe(limit);
      } finally {
        release.resolve();
        await execution;
      }
      const result = await execution;
      const expected = Array.from({ length: count }, (_, i) => ({ value: String(i) }));
      expect(result).toMatchObject({
        status: "completed",
        value: { value: expected.map((row) => row.value).join(",") },
      });
      expect(inputs).toEqual([...expected, { value: expected.map((row) => row.value).join(",") }]);
      expect(maximum).toBe(limit);
      expect(active).toBe(0);
    },
  );

  it("refuses queue overflow even when the guest catches the error", async () => {
    const tool = pluginToolWithExecute("probe", "Must not dispatch", async () => jsonResult({}));
    const run = harness(false, 2, tool);
    const fanout = "for (let i = 0; i < 131; i++) void probe({ value: String(i) });";
    const result = await run(
      "try {" + fanout + '} catch (e) { text(e.message); } return "caught";',
    );
    expect(result).toMatchObject({ status: "failed", code: "invalid_input" });
    expect(result.error).toContain("queue limit exceeded");
    expect(result.error).toContain("Await smaller batches");
    expect(tool.execute).not.toHaveBeenCalled();
    expect(result.output).toEqual([
      { type: "text", text: expect.stringContaining("queue limit exceeded") },
    ]);
    // A failed admission belongs to one VM, not the reusable worker.
    expect(await run('return await probe({ value: "fresh" });')).toMatchObject({
      status: "completed",
    });
    expect(tool.execute).toHaveBeenCalledOnce();
  });

  it("cancels queued timers without admitting them and drains live timer callbacks", async () => {
    const tool = pluginToolWithExecute("probe", "Timer probe", async (_id, input) =>
      jsonResult(input),
    );
    const result = await harness(
      false,
      1,
      tool,
    )(
      'const first = probe({ value: "first" });' +
        'for (let i = 0; i < 160; i++) { const timer = setTimeout(() => { throw new Error("canceled timer fired"); }, 60000); clearTimeout(timer); }' +
        "const timers = Array.from({ length: 20 }, (_, i) => new Promise(resolve => setTimeout(async () => resolve(await probe({ value: String(i) })), 0)));" +
        "await first; return (await Promise.all(timers)).map(row => row.value);",
    );
    expect(result).toMatchObject({
      status: "completed",
      value: Array.from({ length: 20 }, (_, i) => String(i)),
    });
    expect(tool.execute).toHaveBeenCalledTimes(21);
  });

  it.each([false, true])(
    "drops queued calls when the owner aborts (headless=%s)",
    async (headless) => {
      const started = createDeferred<AbortSignal | undefined>();
      const release = createDeferred();
      const controller = new AbortController();
      const tool = pluginToolWithExecute(
        "probe",
        "Canceled queue probe",
        async (_id, _input, signal) => {
          started.resolve(signal);
          await release.promise;
          return jsonResult({});
        },
      );
      const execution = harness(
        headless,
        1,
        tool,
      )(
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
    },
  );
});

it("carries queued calls through a public exec/wait without replaying the prefix", async () => {
  const config: OpenClawConfig = { tools: { codeMode: true } };
  const ctx = {
    config,
    runtimeConfig: config,
    catalogRef: createToolSearchCatalogRef(),
    runId: "wait-backpressure",
    sessionId: "wait-session",
  };
  const tools = createCodeModeTools(ctx);
  const probe = pluginToolWithExecute("probe", "Wait queue probe", async (_id, input) =>
    jsonResult(input),
  );
  applyCodeModeCatalog({ ...ctx, tools: [...tools, probe] });
  const parked = resultDetails(
    await expectDefined(tools[0], "exec").execute("park", {
      code: 'const pause = yield_control("pause"); const calls = Array.from({ length: 20 }, (_, i) => probe({ value: String(i) })); await pause; return await Promise.all(calls);',
    }),
  );
  expect(parked.status).toBe("waiting");
  expect(testing.activeRuns.size).toBe(1);
  const result = resultDetails(
    await expectDefined(tools[1], "wait").execute("resume", { runId: parked.runId }),
  );
  expect(result).toMatchObject({
    status: "completed",
    value: Array.from({ length: 20 }, (_, i) => ({ value: String(i) })),
  });
  expect(probe.execute).toHaveBeenCalledTimes(20);
});

it("keeps the headless total tool-count guard while draining queued calls", async () => {
  const tool = pluginToolWithExecute("probe", "Budget probe", async () => jsonResult({}));
  const result = await harness(true, 2, tool)(
    "return await Promise.all(Array.from({ length: 20 }, () => probe({})));",
    undefined,
    5,
  );
  expect(result).toMatchObject({ status: "failed", code: "tool_budget_exceeded" });
  expect(tool.execute).toHaveBeenCalledTimes(4);
});
