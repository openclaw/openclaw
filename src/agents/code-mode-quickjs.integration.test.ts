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

afterEach(resetCodeModeTestState);

function snapshotFixture() {
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
  const code = `void snapshot_pending({});
    text("accepted first");
    await output_fixture({});
    const retained = new Uint8Array(16 * 1024 * 1024);
    retained[0] = 7;
    text("accepted inline");
    await yield_control();
    await snapshot_fresh({});
    return retained[0];`;
  return { pendingStarted, pending, fixture, fresh, code };
}

describe("QuickJS checkpoint admission through Code Mode", () => {
  it.each(["exec", "wait", "headless"] as const)(
    "preserves output and cancels earlier tools when a %s resume exceeds the snapshot cap",
    async (mode) => {
      const { pendingStarted, pending, fixture, fresh, code } = snapshotFixture();
      let result: CodeModeHeadlessResult | ReturnType<typeof resultDetails>;
      if (mode === "headless") {
        result = await runCodeModeScriptHeadless({
          ctx: createHeadlessCodeModeHarness([pending, fixture, fresh], {
            codeMode: { executor: "quickjs" },
          }),
          code,
        });
        expect(result.toolCallCount).toBe(2);
      } else {
        const { ctx, config, tools } = createCodeModeHarness({ codeMode: { executor: "quickjs" } });
        applyCodeModeCatalog({ ...ctx, config, tools: [...tools, pending, fixture, fresh] });
        const exec = expectDefined(tools[0], "exec");
        const wait = expectDefined(tools[1], "wait");
        const input = {
          code: `${mode === "wait" ? 'text("delivered"); await yield_control();' : ""}${code}`,
        };
        const first =
          mode === "wait" ? resultDetails(await exec.execute("park", input)) : undefined;
        if (first) {
          expect(first).toMatchObject({
            status: "waiting",
            output: [{ type: "text", text: "delivered" }],
          });
        }
        result = resultDetails(
          await (first
            ? wait.execute("resume", { runId: first.runId })
            : exec.execute("inline", input)),
        );
      }
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
});
