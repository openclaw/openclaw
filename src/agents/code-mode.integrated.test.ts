import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as worker from "./code-mode-worker.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

describe("integrated public Code Mode", () => {
  it.each(["exec", "wait", "headless"])(
    "keeps 12 MiB live through timer/tool boundaries: %s",
    async (mode) => {
      const target = pluginToolWithExecute("rows", "Read rows", async () => jsonResult([{ n: 7 }]));
      const code =
        'const heap = new Uint8Array(12 * 1024 * 1024); heap[0] = 73; console.log("once"); await new Promise(resolve => setTimeout(resolve, 0)); const data = await rows({}); return [heap.length, heap[0], data[0].n];';
      let result;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([target]),
          code,
        });
      } else {
        const { ctx, config, tools } = createCodeModeHarness();
        applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
        result = resultDetails(
          await tools[0]!.execute("integrated", {
            code: (mode === "wait" ? "await yield_control(); " : "") + code,
          }),
        );
        if (mode === "wait") {
          expect(result.status).toBe("waiting");
          result = resultDetails(await tools[1]!.execute("resume", { runId: result.runId }));
        }
      }
      expect(result, JSON.stringify(result)).toMatchObject({
        status: "completed",
        value: [12582912, 73, 7],
        output: [{ type: "text", text: "once" }],
      });
      expect(target.execute).toHaveBeenCalledOnce();
    },
  );

  it("still enforces the actual checkpoint limit", async () => {
    const { ctx, config, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, config, tools });
    const result = resultDetails(
      await tools[0]!.execute("checkpoint", {
        code: "const heap = new Uint8Array(12 * 1024 * 1024); await yield_control(); return heap.length;",
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
  });

  it.each([
    { language: "javascript" },
    { language: "typescript" },
    { typecheck: false },
    { typecheck: true },
  ])("rejects retired compiler options before effects: %j", async (retired) => {
    const target = pluginToolWithExecute("effect", "Effect", async () => jsonResult("done"));
    const { ctx, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, tools: [...tools, target] });

    await expect(
      tools[0]!.execute("retired-options", { code: "await effect();", ...retired }),
    ).rejects.toThrow(
      "Code Mode accepts JavaScript only. Remove language and typecheck; use API.read(...) for tool types.",
    );
    expect(target.execute).not.toHaveBeenCalled();
  });

  it.each([
    "const value: number = 1; return value;",
    "interface Value { count: number } return 1;",
    "return { count: 1 } satisfies { count: number };",
  ])("rejects TypeScript syntax before any effects: %s", async (code) => {
    const target = pluginToolWithExecute("effect", "Effect", async () => jsonResult("done"));
    const { ctx, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, tools: [...tools, target] });

    const result = resultDetails(
      await tools[0]!.execute("typescript-source", { code: "await effect();\n" + code }),
    );
    expect(result).toMatchObject({
      status: "failed",
      bridgeDispatchStarted: false,
      error: expect.stringContaining("SyntaxError"),
    });
    expect(result.error).toMatch(/openclaw-code-mode:user\.js:2:\d+/);
    expect(target.execute).not.toHaveBeenCalled();
  });

  it("composes JavaScript from API declarations and rejects invalid arguments at dispatch", async () => {
    const target = pluginToolWithExecute("contract", "Contract", async (_id, input) =>
      jsonResult({ count: (input as { count: number }).count + 6 }),
    );
    target.parameters = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    target.outputSchema = Type.Object({ count: Type.Number() }, { additionalProperties: false });
    const { ctx, tools } = createCodeModeHarness();
    applyCodeModeCatalog({ ...ctx, tools: [...tools, target] });
    const declared = resultDetails(
      await tools[0]!.execute("read-contract", {
        code: 'return await API.read("tools/contract.d.ts");',
      }),
    );
    expect(declared).toMatchObject({
      status: "completed",
      value: { content: expect.stringContaining("count: number") },
    });
    expect(target.execute).not.toHaveBeenCalled();

    const result = resultDetails(
      await tools[0]!.execute("compose", {
        code: `
          const first = await contract({count: 1});
          const second = await contract({count: first.count});
          try { await contract({count: "bad"}); }
          catch (error) { return { count: second.count, code: error.code }; }
          throw new Error("invalid input was accepted");
        `,
      }),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
      value: { count: 13, code: "input_contract" },
    });
    expect(target.execute).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "refuses a new host effect after the boundary deadline (resume=%s)",
    async (resume) => {
      const target = pluginToolWithExecute("late_effect", "Must not dispatch late", async () =>
        jsonResult({ done: true }),
      );
      const { ctx, config, tools } = createCodeModeHarness();
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, target] });
      const clock = vi.spyOn(performance, "now").mockReturnValue(0);
      const original = worker.runCodeModeWorker;
      const spy = vi.spyOn(worker, "runCodeModeWorker").mockImplementation(async (...args) => {
        const inline = args[4];
        if (!inline) {
          return await original(...args);
        }
        return await original(args[0], args[1], args[2], args[3], {
          ...inline,
          onBoundary: async (boundary, context) => {
            if (boundary.pendingRequests.some((request) => request.method === "callValue")) {
              clock.mockReturnValue(100_000);
            }
            return await inline.onBoundary(boundary, context);
          },
        });
      });
      try {
        let result = resultDetails(
          await tools[0]!.execute("late", {
            code: (resume ? "await yield_control(); " : "") + "return await late_effect({});",
          }),
        );
        if (resume) {
          expect(result.status).toBe("waiting");
          result = resultDetails(await tools[1]!.execute("late-resume", { runId: result.runId }));
        }
        expect(target.execute).not.toHaveBeenCalled();
        expect(result, JSON.stringify(result)).toMatchObject({ status: "failed", code: "timeout" });
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
    },
  );
});
