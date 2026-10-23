import path from "node:path";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  createCodexTestBindingStore,
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  type writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";

type SettledFinalizationFixtures = {
  expectResumeRequest: (
    requests: Array<{ method: string; params: unknown }>,
    params: Record<string, unknown>,
  ) => void;
  writeExistingBinding: (
    sessionFile: string,
    workspaceDir: string,
    overrides?: Partial<Parameters<typeof writeCodexAppServerBinding>[1]>,
  ) => Promise<void>;
};

async function settledParams(name: string, prompt: string) {
  const sessionId = `session-${name}`;
  const sessionFile = `agent:main:${sessionId}`;
  const workspaceDir = path.join(tempDir, `workspace-${name}`);
  const params = createParams(sessionFile, workspaceDir);
  await attachSqliteSessionTarget(params, path.join(tempDir, `${name}.sqlite`), sessionId);
  params.prompt = prompt;
  params.onSettledTurn = async (attempt, captureContext) => {
    attempt.settledTurnFinalizationContext = await captureContext();
  };
  return { params, sessionFile, workspaceDir };
}

function commandEvents(cwd: string, output: string) {
  const command = { type: "commandExecution", id: "tool-settled", command: `echo ${output}`, cwd };
  return [
    itemNotification("item/started", { ...command, status: "inProgress" }),
    itemNotification("item/completed", {
      ...command,
      status: "completed",
      aggregatedOutput: `${output}\n`,
      exitCode: 0,
      durationMs: 12,
    }),
  ];
}

/** Keep finalization evidence cases under the parent suite's original hooks and ordering. */
export function registerSettledFinalizationTests({
  expectResumeRequest,
  writeExistingBinding,
}: SettledFinalizationFixtures) {
  it.each([
    ["preserve-only host-auth turn", undefined, true],
    [
      "provider overload after the tool result",
      {
        message: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
      },
      false,
    ],
  ] as const)(
    "preserves settled finalization eligibility for a %s",
    async (_label, failure, preserveNativeModel) => {
      const { params, sessionFile, workspaceDir } = await settledParams(
        "settled-finalization-context",
        "Send the update to Alice.",
      );
      const sourceSelection = { model: "gpt-5.6-luna", modelProvider: "openai" };
      const onStart = vi.fn();
      const harness = createStartedThreadHarness(
        async (method) =>
          method === "thread/start" || method === "thread/resume"
            ? { ...threadStartResult(), ...sourceSelection }
            : undefined,
        { onStart, ...(preserveNativeModel ? { persistedThreads: ["thread-1"] } : {}) },
      );
      params.registerPluginRuntimeRefreshConsumer = vi.fn();
      params.modelId = "synthetic-outer-model";
      params.authProfileStore = {
        version: 1,
        order: { openai: ["openai:ordered"] },
        profiles: {
          "openai:ordered": { type: "api_key", provider: "openai", key: "synthetic-ordered-key" },
          "openai:binding": { type: "api_key", provider: "openai", key: "synthetic-binding-key" },
        },
      };
      if (preserveNativeModel) {
        registerCodexTestSessionIdentity(sessionFile, params.sessionId, params.sessionKey);
        await writeExistingBinding(sessionFile, workspaceDir, {
          threadId: "thread-1",
          model: "synthetic-previous-model",
          preserveNativeModel: true,
          authProfileId: "openai:binding",
        });
      }
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      const emptyAssistant = { type: "agentMessage", id: "empty-assistant", text: "" };
      // Native events arrive in wire order; local projection must not delay terminal receipt.
      await Promise.all([
        harness.notify(itemNotification("item/started", emptyAssistant)),
        harness.notify(itemNotification("item/completed", emptyAssistant)),
        ...commandEvents(workspaceDir, "sent-to-alice").map((event) => harness.notify(event)),
        failure
          ? harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: failure }))
          : harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }),
      ]);
      const result = await run;
      const selectedProfile = preserveNativeModel ? "openai:binding" : "openai:ordered";
      expect(onStart).toHaveBeenCalledWith(selectedProfile, expect.anything(), expect.anything());
      if (preserveNativeModel) {
        expect(params.registerPluginRuntimeRefreshConsumer).not.toHaveBeenCalled();
        expectResumeRequest(harness.requests, { threadId: "thread-1" });
        const resume = harness.requests.find((request) => request.method === "thread/resume");
        expect(resume?.params).not.toHaveProperty("model");
        await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
          preserveNativeModel: true,
          authProfileId: selectedProfile,
          ...sourceSelection,
        });
      }
      expect(Boolean(readAttemptTerminal(result).promptError)).toBe(Boolean(failure));
      if (!failure) {
        expect(result.terminal).toEqual({ kind: "ok" });
      }
      expect(result.currentAttemptAssistant).toBeDefined();
      expect(result).toMatchObject({
        replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
      });
      const context = result.settledTurnFinalizationContext;
      expect(context).toMatchObject({
        source: "harness",
        selection: { ...sourceSelection, authProfileId: selectedProfile },
      });
      if (!(context instanceof settledTurnContext.CodexSettledTurnContext)) {
        throw new Error("Expected complete settled-turn evidence from the harness");
      }
      expect(context.data).toEqual([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: expect.stringContaining(params.prompt) }],
        },
        {
          type: "function_call",
          call_id: "tool-settled",
          name: "bash",
          arguments: JSON.stringify({ command: "echo sent-to-alice", cwd: workspaceDir }),
        },
        { type: "function_call_output", call_id: "tool-settled", output: "sent-to-alice\n" },
      ]);
    },
  );
  it.each([
    { label: "completed reply", final: undefined, preservesResult: true },
    { label: "progress reply", final: false, preservesResult: false },
  ])(
    "preserves only a projected canonical $label when native binding retention fails",
    async ({ label, final, preservesResult }) => {
      const bindingStore = createCodexTestBindingStore();
      const originalMutate = bindingStore.mutate.bind(bindingStore);
      const sessionFile = path.join(tempDir, `session-source-reply-finalization-${label}.jsonl`);
      const workspaceDir = path.join(tempDir, `workspace-source-reply-finalization-${label}`);
      const params = createParams(sessionFile, workspaceDir);
      const messageTool = createRuntimeDynamicTool("message");
      messageTool.parameters = {
        type: "object",
        properties: {
          action: { type: "string" },
          message: { type: "string" },
          final: { type: "boolean" },
        },
        required: ["action", "message"],
      };
      messageTool.execute = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "Sent." }],
        details: {
          messageId: "source-reply-1",
          messageDelivery: {
            status: "settled" as const,
            partialDelivery: false,
            createdThreadIds: [],
            sourceReplyDelivered: true,
          },
        },
      }));
      setCodexTestToolFactory(params, () => [messageTool]);
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.sourceReplyDeliveryMode = "message_tool_only";
      setCodexTestModelSupportsTools(params, true);
      let failBindingRetention = false;
      const failingBindingStore: typeof bindingStore = {
        ...bindingStore,
        async mutate(...args: Parameters<typeof bindingStore.mutate>): Promise<boolean> {
          if (failBindingRetention) {
            throw new Error("binding retention failed after source delivery");
          }
          return await originalMutate(...args);
        },
      };
      const harness = createStartedThreadHarness();
      const closeHostCapabilities = await bindProductionHarnessHostCapabilitiesForTest(params);
      try {
        const run = runCodexAppServerAttempt(params, { bindingStore: failingBindingStore });
        await harness.waitForMethod("turn/start");
        await expect(
          harness.handleServerRequest({
            id: "source-reply-1",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "source-reply-1",
              namespace: null,
              tool: "message",
              arguments: {
                action: "send",
                message: "Visible source reply",
                ...(final === false ? { final } : {}),
              },
            },
          }),
        ).resolves.toMatchObject({
          success: true,
          contentItems: [{ type: "inputText", text: "Sent." }],
        });
        expect(messageTool.execute).toHaveBeenCalledOnce();
        failBindingRetention = true;
        await harness.notify(turnCompleted({ id: "turn-1", status: "completed" }));

        if (!preservesResult) {
          await expect(run).rejects.toThrow("binding retention failed after source delivery");
        } else {
          const result = await run;
          expect(result.sourceReplyDelivered).toBe(true);
          expect(readAttemptTerminal(result)).toMatchObject({
            promptError: expect.objectContaining({
              message:
                "Native finalization failed after the source reply was delivered. Inspect the existing thread before continuing; do not repeat the completed reply.",
            }),
          });
        }
      } finally {
        closeHostCapabilities();
      }
    },
  );
  it("captures settled tool evidence when an active native compaction fails terminally", async () => {
    const { params, workspaceDir } = await settledParams(
      "settled-compaction-failure",
      "Finish the task and report the result.",
    );
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const error = {
      message: "remote compaction failed",
      codexErrorInfo: "other",
      additionalDetails: null,
    };
    // Native events arrive in wire order; local projection must not delay terminal receipt.
    await Promise.all([
      ...commandEvents(workspaceDir, "completed-work").map((event) => harness.notify(event)),
      harness.notify(
        itemNotification("item/started", { type: "contextCompaction", id: "compact-failed" }),
      ),
      harness.notify({
        method: "error",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          error,
          willRetry: false,
        },
      }),
      harness.notify(turnCompleted({ id: "turn-1", status: "failed", error })),
    ]);

    const result = await run;

    expect(readAttemptTerminal(result)).toMatchObject({
      promptError: "remote compaction failed",
      promptErrorSource: "compaction",
    });
    expect(result.itemLifecycle).toEqual({ startedCount: 2, completedCount: 1, activeCount: 0 });
    expect(result.settledTurnFinalizationContext).toMatchObject({
      source: "harness",
      data: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ type: "function_call" }),
        expect.objectContaining({ type: "function_call_output", call_id: "tool-settled" }),
      ],
    });
  });
}
