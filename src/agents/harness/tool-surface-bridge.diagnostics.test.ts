import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as events from "../../infra/diagnostic-events.js";
import * as activity from "../../logging/diagnostic-run-activity.js";
import { resetCodeModeTestState, resultDetails } from "../code-mode.test-support.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./tool-surface-bridge.js";

beforeEach(() => {
  events.setDiagnosticsEnabledForProcess(true);
  activity.startDiagnosticRunActivityTracking();
});

afterEach(async () => {
  await resetCodeModeTestState();
  activity.resetDiagnosticRunActivityForTest();
  events.resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

it.each([
  { control: "exec", terminal: "complete" },
  { control: "wait", terminal: "complete" },
  { control: "exec", terminal: "abort" },
] as const)(
  "Code Mode tracks $control after nested completion until $terminal",
  async ({ control, terminal }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const ref = {
      sessionId: "code-mode-diagnostics",
      sessionKey: "agent:main:code-mode-diagnostics",
      runId: "code-mode-diagnostics-run",
    };
    const nestedCompleted = createDeferred();
    const release = createDeferred();
    const abort = new AbortController();
    const spawn = createStubTool("sessions_spawn");
    spawn.execute = async () => jsonResult({ status: "accepted", runId: "child-run" });
    const runtime = createAgentHarnessToolSurfaceRuntimeCore({
      ...ref,
      agentId: "main",
      config: { tools: { codeMode: true } },
      modelToolsEnabled: true,
      executeTool: async (call) => {
        // This catalog contains only the native spawn fixture, not a client callback.
        const result = await (call.tool as AnyAgentTool).execute(
          call.toolCallId,
          call.input,
          call.signal,
          call.onUpdate,
        );
        await events.waitForDiagnosticEventsDrained();
        nestedCompleted.resolve();
        // Source execution has ended; its caller still owns the pending result.
        await release.promise;
        return call.acceptResultBeforeProjection(result);
      },
    });
    const { tools } = runtime.compactTools([spawn], { hookContext: ref });
    const getControl = (name: string) =>
      expectDefined(
        tools.find((tool) => tool.name === name),
        `${name} control`,
      );
    activity.markDiagnosticEmbeddedRunStarted(ref);
    const code = "return await sessions_spawn({});";
    const input =
      control === "wait"
        ? {
            runId: resultDetails(
              await getControl("exec").execute("park", {
                title: "Start nested spawn",
                code: `await yield_control(); ${code}`,
              }),
            ).runId,
          }
        : { title: "Await nested spawn", code, awaitResults: true };
    const active = getControl(control);
    const execution = active.execute("outer-call", input, abort.signal);
    try {
      await nestedCompleted.promise;
      now.mockReturnValue(1_000 + 7 * 60_000);
      const pending = activity.getDiagnosticSessionActivitySnapshot(ref);
      expect(pending).toMatchObject({
        activeWorkKind: "tool_call",
        activeToolName: control,
        activeToolCallId: "outer-call",
        lastProgressReason: "tool:sessions_spawn:ended",
      });
      expect(activity.resolveRunStaleThresholdMs(pending)).toBeGreaterThan(
        pending.lastProgressAgeMs!,
      );

      if (terminal === "abort") {
        abort.abort();
      } else {
        release.resolve();
      }
      expect(resultDetails(await execution)).toMatchObject(
        terminal === "abort" ? { status: "failed", code: "aborted" } : { status: "completed" },
      );
      await events.waitForDiagnosticEventsDrained();
      now.mockReturnValue(1_000 + 14 * 60_000);
      const settled = activity.getDiagnosticSessionActivitySnapshot(ref);
      expect(settled.activeToolName).toBeUndefined();
    } finally {
      abort.abort();
      release.resolve();
      await execution;
      runtime.cleanup();
    }
  },
);
