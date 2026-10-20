import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runCodeModeScriptHeadless, type CodeModeHeadlessResult } from "./code-mode.js";
import {
  createCatalogCodeModeHarness,
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  expectCodeModeSharedBudget,
  expectOriginalCodeModeMarker,
  expectToolCalls,
  pluginTool,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";

afterEach(resetCodeModeTestState);
const quickjs = { codeMode: { executor: "quickjs" as const } };
const textOutput = (...texts: string[]) => texts.map((text) => ({ type: "text", text }));

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

it("yields and resumes a direct executor call without an inline host", async () => {
  const { ctx } = createCodeModeHarness(quickjs);
  const config = testing.resolveCodeModeHeadlessConfig(ctx);
  const options = {
    executor: "quickjs" as const,
    runtimeConfig: ctx.config,
    timeoutMs: config.timeoutMs,
  };
  const result = await testing.runCodeModeExecutor(
    {
      kind: "exec",
      source: "const value = 42; await yield_control(); return value;",
      config,
      catalog: [],
      namespaces: [],
    },
    options,
  );
  assert(result.status === "waiting", JSON.stringify(result));
  expect(
    await testing.runCodeModeExecutor(
      {
        kind: "resume",
        continuation: result.continuation,
        config,
        settledRequests: result.pendingRequests.map(({ id }) => ({ id, ok: true, json: "null" })),
        pendingRequests: [],
      },
      options,
    ),
  ).toMatchObject({ status: "completed", value: { json: "42" } });
});
it.each(["exec", "wait", "headless"] as const)(
  "preserves output and cancels earlier tools when a %s resume exceeds the snapshot cap",
  async (mode) => {
    const { pendingStarted, pending, fixture, fresh, code } = snapshotFixture();
    let result: CodeModeHeadlessResult | ReturnType<typeof resultDetails>;
    if (mode === "headless") {
      result = await runCodeModeScriptHeadless({
        ctx: createHeadlessCodeModeHarness([pending, fixture, fresh], quickjs),
        code,
      });
      expect(result.toolCallCount).toBe(2);
    } else {
      const h = createCatalogCodeModeHarness([pending, fixture, fresh], quickjs);
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
    expectToolCalls(1, pending, fixture);
    expectToolCalls(0, fresh);
    expect((await pendingStarted.promise).aborted).toBe(true);
    expect(result.output).toEqual(textOutput("accepted first", "accepted inline"));
    expect(testing.activeRuns.size).toBe(0);
  },
);

it.each(["abort", "restart-safe"])("shares the output budget with %s diagnostics", async (mode) => {
  const controller = new AbortController();
  const fixture = pluginToolWithExecute("output_fixture", "Output fixture", async () => {
    controller.abort();
    return { content: [], details: true };
  });
  const { tools } = createCatalogCodeModeHarness([fixture], {
    codeMode: { executor: "quickjs", maxOutputBytes: 1024 },
  });
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
  expectOriginalCodeModeMarker((result.output as unknown[])[0], textOutput("🦞".repeat(1000)));
  expectCodeModeSharedBudget(result, 1024);
  expect(testing.activeRuns.size).toBe(0);
});
