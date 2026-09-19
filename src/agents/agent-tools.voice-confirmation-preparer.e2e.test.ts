import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { resetDiagnosticEventsForTest } from "../infra/diagnostic-events.js";
import { resetDiagnosticSessionStateForTest } from "../logging/diagnostic-session-state.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "../talk/client-voice-confirmation.test-support.js";
import * as clientVoiceSession from "../talk/client-voice-session.js";
import { toClientToolDefinitions, toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  consumeAdjustedParamsForToolCall,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import {
  consumeTrackedToolExecutionStarted,
  resetAdjustedParamsByToolCallIdForTests,
} from "./agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  approveVoiceToolParams,
  installVoiceRunBinding,
} from "./agent-tools.voice-confirmation.test-support.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "./plugin-runtime-refresh.js";
import {
  getInternalToolExecutionPreparer,
  type InternalToolExecutionPreparer,
} from "./runtime/internal-hooks.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";

function createMessageSource() {
  const execute = vi.fn<AnyAgentTool["execute"]>(async () => ({
    content: [],
    details: { ok: true },
  }));
  const parameters = {
    type: "object",
    properties: {
      action: { type: "string" },
      to: { type: "string" },
      message: { type: "string" },
    },
    required: ["action", "to", "message"],
  };
  const source: AnyAgentTool = {
    name: "message",
    label: "Message",
    description: "Synthetic message tool",
    parameters,
    execute,
  };
  return { source, execute, parameters };
}

describe("prepared voice tool cancellation", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    resetDiagnosticSessionStateForTest();
    resetAdjustedParamsByToolCallIdForTests();
    resetDiagnosticEventsForTest();
    resetClientVoiceConfirmationStateForTest();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_tool_call", handler: async () => undefined }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    resetGlobalHookRunner();
    resetClientVoiceConfirmationStateForTest();
    resetAdjustedParamsByToolCallIdForTests();
    vi.restoreAllMocks();
  });

  it.each(["wrapped", "adapter", "client-hosted"] as const)(
    "preserves same-run approval after post-execute cancellation through the %s owner",
    async (owner) => {
      const runId = `run-voice-prepared-cancel-${owner}`;
      const toolCallId = `call-voice-prepared-cancel-${owner}`;
      const toolParams = { action: "send", to: "target-a", message: "approved body" };
      const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
      const run = new AbortController();
      const call = new AbortController();
      const callSignal = (controller: AbortController) =>
        owner === "client-hosted"
          ? AbortSignal.any([run.signal, controller.signal])
          : controller.signal;
      installVoiceRunBinding(runId);
      approveVoiceToolParams(runId, toolParams);
      const { source, execute, parameters } = createMessageSource();
      const recorder = { reserve: vi.fn(), complete: vi.fn(), discard: vi.fn() };
      const definition = expectDefined(
        owner === "client-hosted"
          ? toClientToolDefinitions(
              [
                {
                  type: "function",
                  function: {
                    name: source.name,
                    description: source.description,
                    parameters,
                  },
                },
              ],
              recorder,
              hookContext,
            )[0]
          : toToolDefinitions(
              [owner === "wrapped" ? wrapToolWithBeforeToolCallHook(source, hookContext) : source],
              hookContext,
              run.signal,
            )[0],
        `${owner} voice tool definition`,
      );
      const tool = wrapToolDefinition(definition);
      const preparer = expectDefined(
        getInternalToolExecutionPreparer(tool),
        `${owner} private execution preparer`,
      );
      const pending: Promise<unknown>[] = [];
      const track = <T>(promise: Promise<T>): Promise<T> => {
        pending.push(Promise.allSettled([promise]));
        return promise;
      };
      let closed = false;
      let prepared: Awaited<ReturnType<typeof preparer>> | undefined;
      const preparation = track(
        preparer({ toolCallId, args: toolParams, signal: callSignal(call) }).then((value) => {
          prepared = value;
          if (closed) {
            value.dispose();
          }
          return value;
        }),
      );

      try {
        prepared = await withTestTimeout(preparation, 2_000, "voice preparation did not finish");
        expect(prepared.kind).toBe("ready");
        if (prepared.kind !== "ready") {
          throw new Error("Expected a prepared voice tool call");
        }
        expect(execute).not.toHaveBeenCalled();
        expect(recorder.complete).not.toHaveBeenCalled();
        expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
        expect(run.signal.aborted).toBe(false);
        expect(call.signal.aborted).toBe(false);
        const onImplementationStart = vi.fn();
        const abortReason = new Error("cancel prepared voice tool call");
        const execution = prepared.execute(onImplementationStart);
        // Launch resolves the private pause; cancellation must precede its continuation.
        call.abort(abortReason);
        const [outcome] = await withTestTimeout(
          Promise.allSettled([track(execution)]),
          2_000,
          "cancelled voice execution did not settle",
        );

        expect.soft(outcome?.status).toBe("rejected");
        if (outcome?.status === "rejected") {
          expect.soft(outcome.reason).toBe(abortReason);
        }
        expect.soft(execute).not.toHaveBeenCalled();
        expect.soft(recorder.complete).not.toHaveBeenCalled();
        expect.soft(onImplementationStart).not.toHaveBeenCalled();
        expect.soft(consumeAdjustedParamsForToolCall(toolCallId, runId)).toBeUndefined();
        expect.soft(consumeTrackedToolExecutionStarted(toolCallId, runId)).toBeUndefined();
        if (owner === "client-hosted") {
          expect.soft(recorder.reserve).toHaveBeenCalledExactlyOnceWith(toolCallId, "message");
          expect.soft(recorder.discard).toHaveBeenCalledExactlyOnceWith(toolCallId, "message");
        }
        expect(run.signal.aborted).toBe(false);
        expect(clientVoiceSession.resolveClientVoiceRunBinding(runId)).toEqual({
          agentId: "main",
          voiceSessionId: `voice-${runId}`,
          sessionKey: "agent:main:voice",
        });
        expect.soft(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);

        const retryId = `${toolCallId}-retry`;
        const retry = await withTestTimeout(
          track(tool.execute(retryId, toolParams, callSignal(new AbortController()))),
          2_000,
          "approved voice retry did not settle",
        );
        expect
          .soft(retry.details)
          .toMatchObject(owner === "client-hosted" ? { status: "pending" } : { ok: true });
        const repeated = await withTestTimeout(
          track(tool.execute(`${toolCallId}-spent`, toolParams, callSignal(new AbortController()))),
          2_000,
          "repeated voice call did not settle",
        );
        expect(repeated.details).toMatchObject({
          status: "blocked",
          deniedReason: "client-voice-confirmation",
        });
        if (owner === "client-hosted") {
          expect(recorder.complete).toHaveBeenCalledExactlyOnceWith(retryId, "message", toolParams);
          expect(execute).not.toHaveBeenCalled();
        } else {
          expect(execute).toHaveBeenCalledExactlyOnceWith(
            retryId,
            toolParams,
            expect.any(AbortSignal),
            undefined,
          );
          expect(recorder.complete).not.toHaveBeenCalled();
        }
      } finally {
        closed = true;
        try {
          prepared?.dispose();
        } finally {
          await withTestTimeout(
            Promise.all(pending),
            2_000,
            "voice cancellation cleanup did not settle",
          );
        }
      }
    },
    10_000,
  );

  it("preserves same-run voice approval across a plugin runtime refresh", async () => {
    const runId = "run-voice-prepared-refresh";
    const toolCallId = "call-voice-prepared-refresh";
    const toolParams = { action: "send", to: "target-a", message: "approved body" };
    const hookContext = { runId, agentId: "main", sessionKey: "agent:main:voice" };
    const run = new AbortController();
    const refresh = createAgentPluginRuntimeRefresh();
    const { source, execute } = createMessageSource();
    const createGenerationTool = () =>
      wrapToolDefinition(
        expectDefined(
          toToolDefinitions(
            [wrapToolWithBeforeToolCallHook(source, hookContext)],
            hookContext,
            run.signal,
          )[0],
          "voice tool definition for current plugin generation",
        ),
      );
    installVoiceRunBinding(runId);
    approveVoiceToolParams(runId, toolParams);
    const pending: Promise<unknown>[] = [];
    const track = <T>(promise: Promise<T>): Promise<T> => {
      pending.push(Promise.allSettled([promise]));
      return promise;
    };
    let closed = false;
    const preparations: Awaited<ReturnType<InternalToolExecutionPreparer>>[] = [];

    try {
      await refresh.run(async () => {
        const owner = captureAgentPluginRuntimeRefresh();
        owner.bindConsumer(() => true);
        const tool = createGenerationTool();
        const preparer = expectDefined(
          getInternalToolExecutionPreparer(tool),
          "voice execution preparer for original plugin generation",
        );
        const preparation = track(
          preparer({ toolCallId, args: toolParams, signal: run.signal }).then((value) => {
            preparations.push(value);
            if (closed) {
              value.dispose();
            }
            return value;
          }),
        );
        const prepared = await withTestTimeout(
          preparation,
          2_000,
          "voice preparation did not finish",
        );
        expect(prepared.kind).toBe("ready");
        if (prepared.kind !== "ready") {
          throw new Error("Expected a prepared voice tool call");
        }
        expect(execute).not.toHaveBeenCalled();
        expect(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
        expect(owner.request()).toBe(true);
        const onImplementationStart = vi.fn();
        const result = await withTestTimeout(
          track(prepared.execute(onImplementationStart)),
          2_000,
          "stale generation execution did not settle",
        );

        expect(result.details).toMatchObject({
          status: "error",
          error: expect.stringContaining("Plugin runtime changed"),
        });
        expect(execute).not.toHaveBeenCalled();
        expect(onImplementationStart).not.toHaveBeenCalled();
        expect(consumeAdjustedParamsForToolCall(toolCallId, runId)).toBeUndefined();
        expect(consumeTrackedToolExecutionStarted(toolCallId, runId)).toBeUndefined();
        expect(run.signal.aborted).toBe(false);
        expect(clientVoiceSession.resolveClientVoiceRunBinding(runId)?.voiceSessionId).toBe(
          `voice-${runId}`,
        );
        expect.soft(snapshotClientVoiceConfirmationStateForTest().approvedGrants).toBe(1);
        prepared.dispose();
      });

      await refresh.run(async () => {
        captureAgentPluginRuntimeRefresh().bindConsumer(() => true);
        const tool = createGenerationTool();
        const retryId = `${toolCallId}-retry`;
        const retry = await withTestTimeout(
          track(tool.execute(retryId, toolParams, new AbortController().signal)),
          2_000,
          "refreshed voice retry did not settle",
        );
        expect.soft(retry.details).toMatchObject({ ok: true });
        const repeated = await withTestTimeout(
          track(tool.execute(`${toolCallId}-spent`, toolParams, new AbortController().signal)),
          2_000,
          "repeated refreshed voice call did not settle",
        );
        expect(repeated.details).toMatchObject({
          status: "blocked",
          deniedReason: "client-voice-confirmation",
        });
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          retryId,
          toolParams,
          expect.any(AbortSignal),
          undefined,
        );
        expect(run.signal.aborted).toBe(false);
      });
    } finally {
      closed = true;
      try {
        for (const prepared of preparations) {
          prepared.dispose();
        }
      } finally {
        refresh.close();
        await withTestTimeout(Promise.all(pending), 2_000, "voice refresh cleanup did not settle");
      }
    }
  }, 10_000);
});
