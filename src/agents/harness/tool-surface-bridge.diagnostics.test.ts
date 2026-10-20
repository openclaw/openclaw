import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import { classifySessionAttention } from "../../logging/diagnostic-session-attention.js";
import { isCodeModeControlTool } from "../code-mode-control-tools.js";
import { resetCodeModeTestState, resultDetails } from "../code-mode.test-support.js";
import { createStubTool } from "../test-helpers/agent-tool-stubs.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "./tool-surface-bridge.js";

beforeEach(() => {
  setDiagnosticsEnabledForProcess(true);
  startDiagnosticRunActivityTracking();
});

afterEach(async () => {
  await resetCodeModeTestState();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

describe("Code Mode diagnostic lifetime", () => {
  it.each([
    { control: "exec", terminal: "complete" },
    { control: "wait", terminal: "complete" },
    { control: "exec", terminal: "abort" },
  ] as const)(
    "tracks $control after nested completion until $terminal",
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
          await waitForDiagnosticEventsDrained();
          nestedCompleted.resolve();
          // Source execution has ended; its caller still owns the pending result.
          await release.promise;
          return call.acceptResultBeforeProjection(result);
        },
      });
      const { tools } = runtime.compactTools([spawn], { hookContext: ref });
      const exec = expectDefined(
        tools.find((tool) => tool.name === "exec"),
        "exec control",
      );
      const wait = expectDefined(
        tools.find((tool) => tool.name === "wait"),
        "wait control",
      );
      markDiagnosticEmbeddedRunStarted(ref);
      const code = "return await sessions_spawn({});";
      const parked =
        control === "wait"
          ? resultDetails(
              await exec.execute("park", {
                title: "Start nested spawn",
                code: `await yield_control(); ${code}`,
              }),
            )
          : undefined;
      const active = control === "exec" ? exec : wait;
      const execution = active.execute(
        "outer-call",
        parked
          ? { runId: parked.runId }
          : { title: "Await nested spawn", code, awaitResults: true },
        abort.signal,
      );
      try {
        await nestedCompleted.promise;
        now.mockReturnValue(1_000 + 7 * 60_000);
        const activity = getDiagnosticSessionActivitySnapshot(ref);
        expect(isCodeModeControlTool(active)).toBe(true);
        expect(activity).toMatchObject({
          activeWorkKind: "tool_call",
          activeToolName: control,
          activeToolCallId: "outer-call",
          lastProgressReason: "tool:sessions_spawn:ended",
        });
        expect(
          classifySessionAttention({
            state: "processing",
            queueDepth: 0,
            activity,
            staleMs: 120_000,
          }),
        ).toMatchObject({ classification: "blocked_tool_call" });
        expect(resolveRunStaleThresholdMs(activity)).toBeGreaterThan(activity.lastProgressAgeMs!);

        if (terminal === "abort") {
          abort.abort();
        } else {
          release.resolve();
        }
        expect(resultDetails(await execution)).toMatchObject(
          terminal === "abort" ? { status: "failed", code: "aborted" } : { status: "completed" },
        );
        await waitForDiagnosticEventsDrained();
        now.mockReturnValue(1_000 + 14 * 60_000);
        const settled = getDiagnosticSessionActivitySnapshot(ref);
        expect(settled.activeToolName).toBeUndefined();
        expect(
          classifySessionAttention({
            state: "processing",
            queueDepth: 0,
            activity: settled,
            staleMs: 120_000,
          }),
        ).toMatchObject({ classification: "stalled_agent_run" });
      } finally {
        abort.abort();
        release.resolve();
        await execution;
        runtime.cleanup();
      }
    },
  );
});
