import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { jsonResult } from "./tools/common.js";

function createLoopHarness(maxOutputBytes?: number) {
  const harness = createCodeModeHarness({ codeMode: { maxOutputBytes } });
  const fixture = fakeTool("loop_fixture", "A stable fixture operation");
  applyCodeModeCatalog({ ...harness.ctx, tools: [...harness.tools, fixture] });
  const [exec, wait] = harness.tools.map((tool) =>
    wrapToolWithBeforeToolCallHook(tool, { ...harness.ctx, loopDetection: { enabled: true } }),
  );
  if (!exec || !wait) {
    throw new Error("Code Mode controls missing");
  }
  return { ...harness, exec, wait, fixture };
}

afterEach(async () => {
  await resetCodeModeTestState();
  vi.useRealTimers();
  resetDiagnosticSessionStateForTest();
});

describe("Code Mode loop protection", () => {
  it.each([
    {
      kind: "discovery",
      code: 'return (await catalog.search("loop_fixture")).map(tool => tool.callableName);',
    },
    { kind: "retained", code: 'return { data: "x".repeat(4096) };' },
    { kind: "guest metadata", code: "return await loop_fixture({});" },
  ] as const)(
    "compares actual $kind outcomes independently of bookkeeping",
    async ({ kind, code }) => {
      const progress = kind === "guest metadata";
      const { exec, fixture } = createLoopHarness(kind === "retained" ? 1024 : undefined);
      let completed = 0;
      if (progress) {
        fixture.execute = async () =>
          jsonResult({
            telemetry: { callCount: ++completed },
            pendingToolCalls: [{ id: `work-${completed}` }],
          });
      }
      const references = new Set<string>();
      for (let index = 0; index < (progress ? 22 : 20); index++) {
        const result = resultDetails(
          await exec.execute(`${kind}-${index}`, {
            title: kind === "discovery" ? `Inspect available tools ${index}` : "Inspect result",
            code,
          }),
        );
        expect(result.status).toBe("completed");
        if (kind === "retained") {
          expect(result.value).toMatchObject({ reference: { id: expect.any(String) } });
          references.add(JSON.stringify(result.value));
        } else if (kind === "discovery") {
          expect(result.value).toEqual(["loop_fixture"]);
          expect(result.telemetry).toMatchObject({ searchCount: index + 1 });
        } else {
          expect(result.value).toEqual({
            telemetry: { callCount: index + 1 },
            pendingToolCalls: [{ id: `work-${index + 1}` }],
          });
        }
      }
      if (kind === "retained") {
        expect(references.size).toBe(20);
      }
      if (!progress) {
        expect(
          resultDetails(
            await exec.execute("blocked", {
              title: kind === "discovery" ? "Recover available tool handles" : "Inspect result",
              code,
            }),
          ),
        ).toMatchObject({ status: "blocked", deniedReason: "tool-loop" });
      }
    },
  );

  it.each([false, true])(
    "compares resumed work rather than bridge ids; changing output=%s",
    async (progress) => {
      const { exec, wait } = createLoopHarness();
      const code = `const [tool] = await catalog.search("loop_fixture");
      for (let index = 0; index < 13; index++) {
        await tool({ value: "unchanged" });
        ${progress ? "json({ completed: index });" : ""}
        await yield_control();
      }
      return "finished";`;
      let result = resultDetails(
        await exec.execute("start-waits", { title: "Start fixture sequence", code }),
      );
      expect(result.status).toBe("waiting");
      const runId = result.runId;
      const pendingIds = new Set<string>();
      for (let index = 0; index < 10; index++) {
        result = resultDetails(await wait.execute(`resume-${index}`, { runId }));
        expect(result.status).toBe("waiting");
        pendingIds.add(JSON.stringify(result.pendingToolCalls));
        expect(result.telemetry).toMatchObject({ callCount: index + 2 });
      }
      expect(pendingIds.size).toBeGreaterThan(1);
      result = resultDetails(await wait.execute("resume-after-streak", { runId }));
      expect(result).toMatchObject(
        progress
          ? { status: "waiting", output: [{ type: "json", value: { completed: 11 } }] }
          : { status: "blocked", deniedReason: "tool-loop" },
      );
    },
  );

  it("allows changing pending operations even when the guest emits no output", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { exec, wait, fixture } = createLoopHarness();
    let started = createDeferred();
    let release = () => {};
    fixture.execute = async (_id, _input, signal) => {
      const pending = createDeferred();
      const onAbort = () => pending.resolve();
      release = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      started.resolve();
      try {
        await pending.promise;
        return jsonResult({ ok: true });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const code =
      'for (let index = 0; index < 12; index++) { await loop_fixture({value: String(index)}); } return "finished";';
    const initial = exec.execute("start-changing-work", { title: "Start changing work", code });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    let result = resultDetails(await initial);
    const runId = result.runId;
    for (let index = 0; index < 12; index++) {
      expect(result.status).toBe("waiting");
      started = createDeferred();
      release();
      const next = wait.execute("advance-work-" + index, { runId });
      if (index < 11) {
        await started.promise;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      result = resultDetails(await next);
    }
    expect(result).toMatchObject({ status: "completed", value: "finished" });
  });
});
