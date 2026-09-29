import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildBlockedToolResult } from "./agent-tools.before-tool-call.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function bridge(targets: AnyAgentTool[], timeoutMs = 10_000) {
  const h = createCodeModeHarness({ codeMode: { timeoutMs } });
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  return async (code: string, signal?: AbortSignal) =>
    resultDetails(await h.tools[0]!.execute("bridge", { code }, signal));
}

afterEach(async () => {
  vi.useRealTimers();
  await resetCodeModeTestState();
});

describe("Code Mode bridge settlement and cancellation", () => {
  it.each([false, true])(
    "drains nested work after a combinator settles (failure=%s)",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
      const started = createDeferred();
      const released = createDeferred();
      const events: string[] = [];
      let aborted = false;
      const slow = pluginToolWithExecute("slow", "Pending action", async (_id, _input, signal) => {
        events.push("slow:start");
        started.resolve();
        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            released.reject(new Error("aborted"));
          },
          { once: true },
        );
        await released.promise;
        events.push("slow:done");
        return jsonResult({ winner: "slow" });
      });
      const fast = pluginToolWithExecute("fast", "Settle the combinator", async () => {
        if (failure) {
          events.push("fast:wait");
        }
        await started.promise;
        events.push("fast:settled");
        if (failure) {
          throw new Error("fast failure");
        }
        return jsonResult({ winner: "fast" });
      });
      const release = pluginToolWithExecute("release", "Release the pending action", async () => {
        events.push("slow:release");
        released.resolve();
        return jsonResult({ released: true });
      });
      const run = bridge([slow, fast, release]);
      const details = await run(
        failure
          ? 'try { await Promise.all([fast({}), slow({})]); return "unexpected success"; } catch (error) { void release({}); return error.message; }'
          : "const value = await Promise.race([Promise.all([slow({})]), fast({})]); void release({}); return value;",
      );
      expect(details).toMatchObject({
        status: "completed",
        value: failure ? "fast failure" : { winner: "fast" },
      });
      for (const tool of [slow, fast, release]) {
        expect(tool.execute).toHaveBeenCalledOnce();
      }
      expect(events).toEqual([
        ...(failure ? ["fast:wait"] : []),
        "slow:start",
        "fast:settled",
        "slow:release",
        "slow:done",
      ]);
      expect(aborted).toBe(false);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("bounds nested exec yield by the shared remaining deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const consume = pluginToolWithExecute("consume", "Consume the shared deadline", async () => {
      vi.advanceTimersByTime(9_600);
      return jsonResult({ consumed: true });
    });
    const shell = pluginToolWithExecute("exec", "Run shell", async (_id, input) =>
      jsonResult(input),
    );
    shell.parameters = Type.Object({
      command: Type.String(),
      yieldMs: Type.Optional(Type.Number()),
      background: Type.Optional(Type.Boolean()),
    });
    expect(
      await bridge([consume, shell])('await consume({}); return await exec({ command: "late" });'),
    ).toMatchObject({
      status: "completed",
      value: { command: "late", yieldMs: 100 },
    });
    expect(consume.execute).toHaveBeenCalledOnce();
    expect(shell.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("supports a guest timer between an action and its observation", async () => {
    const input = pluginTool("fake_terminal_input", "Send terminal input");
    const read = pluginTool("fake_terminal_read", "Read terminal output");
    const details = await bridge([input, read])(`
      const cancelled = setTimeout(() => { throw new Error("cancelled timer fired"); }, 30_000);
      await fake_terminal_input({ data: "status\\n" });
      clearTimeout(cancelled);
      await new Promise(resolve => setTimeout(resolve, 5));
      return await fake_terminal_read({});
    `);
    expect(details, JSON.stringify(details)).toMatchObject({
      status: "completed",
      value: { name: "fake_terminal_read" },
    });
    expect(input.execute).toHaveBeenCalledOnce();
    expect(read.execute).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("fails fast without parking a suspended run when the exec call is aborted", async () => {
    const stuck = pluginToolWithExecute(
      "stuck",
      "Ignore cancellation",
      async () => await new Promise<never>(() => {}),
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await bridge([stuck], 30_000)("await stuck({}); return 'done';", controller.signal),
    ).toMatchObject({
      status: "failed",
      error: "code mode execution aborted",
      code: "aborted",
    });
    expect(stuck.execute).not.toHaveBeenCalled();
    expect(testing.activeRuns.size).toBe(0);
  });

  it("terminates a running guest promptly when the exec call is aborted", async () => {
    const run = bridge([pluginTool("noop", "Noop")], 30_000);
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 200);
    const startedAt = Date.now();
    try {
      expect(await run("while (true) {}", controller.signal)).toMatchObject({
        status: "failed",
        error: "code mode execution aborted",
        code: "aborted",
      });
    } finally {
      clearTimeout(abortTimer);
    }
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(testing.activeRuns.size).toBe(0);
  });

  it("surfaces policy blocks as guest call errors for declared outputs", async () => {
    const target = pluginTool("blocked", "Return policy-controlled rows");
    target.outputSchema = Type.Array(
      Type.Object({ id: Type.String() }, { additionalProperties: false }),
    );
    target.execute = vi.fn(async () =>
      buildBlockedToolResult({ reason: "blocked by orchard policy" }),
    );
    const result = await bridge([target])(
      "try { const rows = await blocked({}); return rows.map(row => row.id); } catch (error) { return error.message; }",
    );
    expect(result.status).toBe("completed");
    expect(result.value).toContain("was blocked before execution: blocked by orchard policy");
  });
});
