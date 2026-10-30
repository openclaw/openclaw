import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "./code-mode.js";
import * as codeMode from "./code-mode.test-support.js";

afterEach(codeMode.resetCodeModeTestState);
const quickjs = { codeMode: { executor: "quickjs" as const } };
const textOutput = (...texts: string[]) => texts.map((text) => ({ type: "text", text }));

function snapshotFixture() {
  const pendingStarted = createDeferred<AbortSignal>();
  const pending = codeMode.pluginToolWithExecute(
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
  const fixture = codeMode.pluginToolWithExecute("output_fixture", "Output fixture", async () => {
    await pendingStarted.promise;
    return { content: [], details: true };
  });
  const fresh = codeMode.pluginTool("snapshot_fresh", "Fresh snapshot fixture");
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

it.each(["exec", "wait", "headless"] as const)(
  "preserves output and cancels earlier tools when a %s resume exceeds the snapshot cap",
  async (mode) => {
    const { pendingStarted, pending, fixture, fresh, code } = snapshotFixture();
    let result: CodeModeHeadlessResult | ReturnType<typeof codeMode.resultDetails>;
    if (mode === "headless") {
      result = await runCodeModeScriptHeadless({
        ctx: codeMode.createHeadlessCodeModeHarness([pending, fixture, fresh], quickjs),
        code,
      });
      expect(result.toolCallCount).toBe(2);
    } else {
      const h = codeMode.createCatalogCodeModeHarness([pending, fixture, fresh], quickjs);
      const first =
        mode === "wait"
          ? await h.run(`text("delivered"); await yield_control(); ${code}`)
          : undefined;
      if (first) {
        expect(first).toMatchObject({
          status: "waiting",
          output: textOutput("delivered"),
        });
      }
      result = first ? await h.resume(first) : await h.run(code);
    }
    expect(result).toMatchObject({ status: "failed", code: "snapshot_limit_exceeded" });
    codeMode.expectToolCalls(1, pending, fixture);
    codeMode.expectToolCalls(0, fresh);
    expect((await pendingStarted.promise).aborted).toBe(true);
    expect(result.output).toEqual(textOutput("accepted first", "accepted inline"));
    expect(codeMode.testing.activeRuns.size).toBe(0);
  },
);

it("shares the output budget with abort diagnostics", async () => {
  const controller = new AbortController();
  const fixture = codeMode.pluginToolWithExecute("output_fixture", "Output fixture", async () => {
    controller.abort();
    return { content: [], details: true };
  });
  const { tools } = codeMode.createCatalogCodeModeHarness([fixture], {
    codeMode: { executor: "quickjs", maxOutputBytes: 1024 },
  });
  const result = codeMode.resultDetails(
    await expectDefined(tools[0], "exec").execute(
      "failure",
      {
        code: 'text("🦞".repeat(1000)); await output_fixture({}); return true;',
      },
      controller.signal,
    ),
  );
  expect(result).toMatchObject({
    status: "failed",
    code: "aborted",
  });
  expect(fixture.execute).toHaveBeenCalledOnce();
  codeMode.expectOriginalCodeModeMarker(
    (result.output as unknown[])[0],
    textOutput("🦞".repeat(1000)),
  );
  codeMode.expectCodeModeSharedBudget(result, 1024);
  expect(codeMode.testing.activeRuns.size).toBe(0);
});
