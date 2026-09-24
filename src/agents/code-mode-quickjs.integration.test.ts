import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  applyCodeModeCatalog,
  runCodeModeScriptHeadless,
  type CodeModeHeadlessResult,
} from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCodeModeSharedBudget,
  expectOriginalCodeModeMarker,
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

function expectFailed(result: CodeModeHeadlessResult) {
  expect(result.status).toBe("failed");
  if (result.status !== "failed") {
    throw new Error("expected headless code mode failure");
  }
  return result;
}

describe("QuickJS checkpoint admission through Code Mode", () => {
  it("still enforces the actual checkpoint limit", async () => {
    const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor: "quickjs" } });
    applyCodeModeCatalog({ ...ctx, config, tools });
    const result = resultDetails(
      await tools[0]!.execute("checkpoint", {
        code: "const heap = new Uint8Array(12 * 1024 * 1024); await yield_control(); return heap.length;",
      }),
    );
    expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
  });

  it.each(["exec", "wait"])(
    "preserves output and cancels earlier tools when a %s resume exceeds the snapshot cap",
    async (mode) => {
      const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor: "quickjs" } });
      const pendingStarted = createDeferred<AbortSignal>();
      const pending = pluginToolWithExecute(
        "snapshot_pending",
        "Pending snapshot fixture",
        async (_toolCallId, _input, signal) => {
          const pendingSignal = expectDefined(signal, "pending bridge signal");
          pendingStarted.resolve(pendingSignal);
          await new Promise<void>((resolve) => {
            pendingSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { content: [], details: true };
        },
      );
      const fixture = pluginToolWithExecute("output_fixture", "Output fixture", async () => {
        await pendingStarted.promise;
        return { content: [], details: true };
      });
      const fresh = pluginTool("snapshot_fresh", "Fresh snapshot fixture");
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pending, fixture, fresh] });
      const exec = expectDefined(tools[0], "exec");
      const wait = expectDefined(tools[1], "wait");
      const input = {
        code: `${mode === "wait" ? 'text("delivered"); await yield_control();' : ""}
          void snapshot_pending({});
          text("accepted first");
          await output_fixture({});
          const retained = new Uint8Array(16 * 1024 * 1024);
          retained[0] = 7;
          text("accepted inline");
          await yield_control();
          await snapshot_fresh({});
          return retained[0];`,
      };
      const first = mode === "wait" ? resultDetails(await exec.execute("park", input)) : undefined;
      if (first) {
        expect(first).toMatchObject({
          status: "waiting",
          output: [{ type: "text", text: "delivered" }],
        });
      }
      const result = resultDetails(
        await (first
          ? wait.execute("resume", { runId: first.runId })
          : exec.execute("inline", input)),
      );
      expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
      expect(pending.execute).toHaveBeenCalledOnce();
      expect(fixture.execute).toHaveBeenCalledOnce();
      expect(fresh.execute).not.toHaveBeenCalled();
      expect((await pendingStarted.promise).aborted).toBe(true);
      expect(result.output).toEqual([
        { type: "text", text: "accepted first" },
        { type: "text", text: "accepted inline" },
      ]);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it.each(["abort", "restart-safe"])(
    "shares the output budget with %s diagnostics",
    async (mode) => {
      const { ctx, config, tools } = createCodeModeHarness({
        codeMode: { executor: "quickjs", maxOutputBytes: 1024 },
      });
      const controller = new AbortController();
      const fixture = pluginToolWithExecute("output_fixture", "Output fixture", async () => {
        controller.abort();
        return { content: [], details: true };
      });
      applyCodeModeCatalog({ ...ctx, config, tools: [...tools, fixture] });
      const result = resultDetails(
        await expectDefined(tools[0], "exec").execute(
          "failure",
          {
            code: 'text("🦞".repeat(1000)); await output_fixture({}); return true;',
            restartSafe: mode === "restart-safe",
          },
          controller.signal,
        ),
      );
      expect(result).toMatchObject({
        status: "failed",
        code: mode === "abort" ? "aborted" : "invalid_input",
      });
      expect(fixture.execute).toHaveBeenCalledTimes(mode === "abort" ? 1 : 0);
      expectOriginalCodeModeMarker((result.output as unknown[])[0], [
        { type: "text", text: "🦞".repeat(1000) },
      ]);
      expectCodeModeSharedBudget(result, 1024);
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("preserves output and cancels earlier tools when a headless resume exceeds the snapshot cap", async () => {
    const pendingStarted = createDeferred<AbortSignal | undefined>();
    const pending = pluginToolWithExecute(
      "headless_snapshot_pending",
      "Headless snapshot fixture",
      async (_toolCallId, _input, signal) => {
        pendingStarted.resolve(signal);
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return jsonResult({ canceled: true });
      },
    );
    const fixture = pluginToolWithExecute(
      "headless_snapshot_fixture",
      "Headless snapshot fixture",
      async () => {
        await pendingStarted.promise;
        return jsonResult({ ok: true });
      },
    );
    const fresh = pluginToolWithExecute(
      "headless_snapshot_fresh",
      "Headless snapshot fixture",
      async () => jsonResult({ ok: true }),
    );
    const result = expectFailed(
      await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([pending, fixture, fresh], {
          codeMode: { executor: "quickjs" },
        }),
        code: `void headless_snapshot_pending({});
          text("accepted first");
          await headless_snapshot_fixture({});
          const retained = new Uint8Array(16 * 1024 * 1024);
          retained[0] = 7;
          text("accepted inline");
          await yield_control();
          await headless_snapshot_fresh({});
          return retained[0];`,
      }),
    );

    expect(result.code).toBe("snapshot_limit_exceeded");
    expect(result.toolCallCount).toBe(2);
    expect(result.output).toEqual([
      { type: "text", text: "accepted first" },
      { type: "text", text: "accepted inline" },
    ]);
    expect(pending.execute).toHaveBeenCalledOnce();
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fresh.execute).not.toHaveBeenCalled();
    expect((await pendingStarted.promise)?.aborted).toBe(true);
  });
});
