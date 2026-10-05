import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as approvalBridge from "./approval-bridge.js";
import type { EmbeddedRunAttemptResult } from "./attempt-terminal.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

function expectSuccessfulAttempt(result: EmbeddedRunAttemptResult): void {
  expect(readAttemptTerminal(result)).toMatchObject({
    aborted: false,
    timedOut: false,
    promptError: null,
  });
}

async function expectTurnInterrupted(
  harness: ReturnType<typeof createStartedThreadHarness>,
): Promise<void> {
  await vi.waitFor(
    () =>
      expect(harness.request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      ),
    { interval: 1 },
  );
}

function createFinalMessageTool(messageId: string) {
  const messageTool = createRuntimeDynamicTool("message");
  messageTool.parameters = {
    type: "object",
    properties: {
      action: { type: "string" },
      message: { type: "string" },
      final: { type: "boolean" },
    },
    additionalProperties: false,
  };
  messageTool.execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Sent." }],
    details: { ok: true, messageId },
  }));
  return messageTool;
}

function configureFinalSourceReplyAttempt() {
  const params = createTestParams();
  params.runtimePlan = createCodexRuntimePlanFixture();
  params.sourceReplyDeliveryMode = "message_tool_only";
  setCodexTestModelSupportsTools(params, true);
  return params;
}

describe("runCodexAppServerAttempt final source reply watches", () => {
  it("waits for native completion after a confirmed final source reply", async () => {
    const messageTool = createFinalMessageTool("source-reply-1");
    const mutationTool = createRuntimeDynamicTool("mutate_after_final");
    const harness = createStartedThreadHarness();
    const params = configureFinalSourceReplyAttempt();
    setCodexTestToolFactory(params, () => [messageTool, mutationTool]);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      await expect(
        harness.handleServerRequest({
          id: "request-final-source-reply",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-final-source-reply",
            namespace: null,
            tool: "message",
            arguments: { action: "send", message: "done", final: true },
          },
        }),
      ).resolves.toMatchObject({ success: true });

      const replayedCall = {
        id: "request-after-final",
        method: "item/tool/call" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-after-final",
          namespace: null,
          tool: "mutate_after_final",
          arguments: {},
        },
      };
      const rejected = await harness.handleServerRequest(replayedCall);
      const replayed = await harness.handleServerRequest(replayedCall);
      expect(rejected).toMatchObject({ success: false });
      expect(replayed).toEqual(rejected);
      expect(mutationTool.execute).not.toHaveBeenCalled();

      expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      expectSuccessfulAttempt(result);
      expect(result.toolMetas).toEqual(
        expect.arrayContaining([expect.objectContaining({ toolName: "message", isError: false })]),
      );
    } finally {
      closeHostCapabilities();
    }
  });

  it("aborts a hanging dynamic tool when the parallel final-source turn completes", async () => {
    const mutationEntered = createDeferred<void>();
    const mutationAborted = createDeferred<unknown>();
    const releaseMutation = createDeferred<void>();
    let mutationSignal: AbortSignal | undefined;
    const mutationTool = createRuntimeDynamicTool("mutate_before_final");
    const executeMutation = vi.fn(async (_id: string, _args: unknown, signal?: AbortSignal) => {
      mutationSignal = signal;
      signal?.addEventListener("abort", () => mutationAborted.resolve(signal.reason), {
        once: true,
      });
      mutationEntered.resolve();
      await releaseMutation.promise;
      return {
        content: [{ type: "text" as const, text: "Mutation complete." }],
        details: {},
      };
    });
    mutationTool.execute = executeMutation;
    const messageTool = createFinalMessageTool("source-reply-parallel");
    const harness = createStartedThreadHarness();
    const params = configureFinalSourceReplyAttempt();
    setCodexTestToolFactory(params, () => [mutationTool, messageTool]);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    const runSettled = vi.fn();
    void run.then(runSettled);
    let mutationResponse: Promise<unknown> | undefined;
    try {
      await harness.waitForMethod("turn/start");
      mutationResponse = harness.handleServerRequest({
        id: "request-mutation-before-final",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-mutation-before-final",
          namespace: null,
          tool: "mutate_before_final",
          arguments: {},
        },
      });
      await mutationEntered.promise;
      await expect(
        harness.handleServerRequest({
          id: "request-final-parallel",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-final-parallel",
            namespace: null,
            tool: "message",
            arguments: { action: "send", message: "done", final: true },
          },
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mutationSignal?.aborted).toBe(false);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await expect(mutationAborted.promise).resolves.toBe("codex_turn_complete");
      expect(mutationSignal).toMatchObject({ aborted: true, reason: "codex_turn_complete" });
      await expect(mutationResponse).resolves.toMatchObject({ success: false });

      releaseMutation.resolve();
      await executeMutation.mock.results[0]?.value;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const result = await run;
      expect(runSettled).toHaveBeenCalledOnce();
      expectSuccessfulAttempt(result);
      expect(mutationTool.execute).toHaveBeenCalledTimes(1);
      expect(result.toolMetas).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: "mutate_before_final", isError: true }),
        ]),
      );
    } finally {
      releaseMutation.resolve();
      await mutationResponse?.catch(() => undefined);
      closeHostCapabilities();
    }
  });

  it("keeps a raw final-source receipt authoritative when result middleware stalls", async () => {
    const middlewareEntered = createDeferred<void>();
    const releaseMiddleware = createDeferred<void>();
    const middleware = vi.fn(async (event: { result: AgentToolResult<unknown> }) => {
      middlewareEntered.resolve();
      await releaseMiddleware.promise;
      return { result: event.result };
    });
    const registry = createEmptyPluginRegistry();
    registry.agentToolResultMiddlewares.push({
      pluginId: "held-result",
      pluginName: "Held Result",
      rawHandler: middleware,
      handler: middleware,
      runtimes: ["codex"],
      source: "test",
    });
    setActivePluginRegistry(registry);
    const messageTool = createFinalMessageTool("source-reply-held");
    const harness = createStartedThreadHarness();
    const params = configureFinalSourceReplyAttempt();
    setCodexTestToolFactory(params, () => [messageTool]);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    let toolResponse: Promise<unknown> | undefined;
    try {
      await harness.waitForMethod("turn/start");
      vi.useFakeTimers();
      toolResponse = harness.handleServerRequest({
        id: "request-final-source-held",
        method: "item/tool/call",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          callId: "call-final-source-held",
          namespace: null,
          tool: "message",
          arguments: { action: "send", message: "done", final: true },
        },
      });
      await middlewareEntered.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await expectTurnInterrupted(harness);
      await harness.notify(turnCompleted({ id: "turn-1", status: "interrupted", items: [] }));
      await expect(toolResponse).resolves.toMatchObject({ success: true });

      const result = await run;
      expectSuccessfulAttempt(result);
      expect(result.messagingToolSentTargets).toEqual(
        expect.arrayContaining([expect.objectContaining({ sourceReplyFinal: true })]),
      );
      expect(result.messagesSnapshot).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "toolResult",
            toolCallId: "call-final-source-held",
            isError: false,
          }),
        ]),
      );
      expect(result.messagesSnapshot).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("missing tool result") }),
        ]),
      );
    } finally {
      releaseMiddleware.resolve();
      await toolResponse?.catch(() => undefined);
      vi.useRealTimers();
      closeHostCapabilities();
    }
  });

  it("declines a pending approval after a final source reply without aborting the turn", async () => {
    const approvalEntered = createDeferred<void>();
    vi.spyOn(approvalBridge, "handleCodexAppServerApprovalRequest").mockImplementation(
      async ({ signal }) => {
        approvalEntered.resolve();
        if (signal?.aborted) {
          return { decision: "cancel" };
        }
        return await new Promise((resolve) => {
          signal?.addEventListener("abort", () => resolve({ decision: "cancel" }), {
            once: true,
          });
        });
      },
    );
    const messageTool = createFinalMessageTool("source-reply-approval");
    const harness = createStartedThreadHarness();
    const params = configureFinalSourceReplyAttempt();
    setCodexTestToolFactory(params, () => [messageTool]);
    const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    try {
      await harness.waitForMethod("turn/start");
      const pendingApproval = harness.handleServerRequest({
        id: "request-approval-before-final",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-before-final",
          command: "echo pending",
          cwd: "/workspace",
        },
      });
      await approvalEntered.promise;
      await expect(
        harness.handleServerRequest({
          id: "request-final-after-approval",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-final-after-approval",
            namespace: null,
            tool: "message",
            arguments: { action: "send", message: "done", final: true },
          },
        }),
      ).resolves.toMatchObject({ success: true });

      await expect(pendingApproval).resolves.toEqual({ decision: "decline" });
      expect(harness.requests.some(({ method }) => method === "turn/interrupt")).toBe(false);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      expectSuccessfulAttempt(await run);
    } finally {
      closeHostCapabilities();
    }
  });
});
