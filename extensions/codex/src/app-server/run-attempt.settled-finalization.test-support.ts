import path from "node:path";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import type { writeCodexAppServerBinding } from "./session-binding.test-helpers.js";
import * as settledTurnContext from "./settled-turn-context.js";
import { getCurrentSharedClientEntry } from "./shared-client-lifecycle.js";
import { retainSharedCodexAppServerClientIfCurrent } from "./shared-client.js";
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
export function registerSettledFinalizationTests(_fixtures: SettledFinalizationFixtures) {
  it.each([
    {
      message:
        "unexpected status 502 Bad Gateway: Codex parent-local inference transport failed; retry on a fresh connection., url: http://127.0.0.1:12345/synthetic-route/responses",
      freshConnection: true,
    },
    { message: "unexpected status 502 Bad Gateway: Unknown error", freshConnection: false },
  ])(
    "preserves completed work after transport failure (fresh connection: $freshConnection)",
    async ({ message, freshConnection }) => {
      const { params, sessionFile, workspaceDir } = await settledParams(
        "transport-recovery",
        "Complete the recorded task.",
      );
      params.registerPluginRuntimeRefreshConsumer = vi.fn();
      const harness = createStartedThreadHarness(undefined, { persistedThreads: ["thread-1"] });
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
      const releaseSibling = retainSharedCodexAppServerClientIfCurrent(harness.client);
      expect(releaseSibling).toBeTypeOf("function");
      try {
        const failure = { message, codexErrorInfo: "other" };
        await harness.notify({
          method: "error",
          params: { threadId: "thread-1", turnId: "turn-1", error: failure, willRetry: false },
        });
        // Error notification alone cannot retire a writer before its terminal outcome.
        expect(getCurrentSharedClientEntry(harness.client)).toBeDefined();
        await Promise.all([
          ...commandEvents(workspaceDir, "work-completed-once").map((event) =>
            harness.notify(event),
          ),
          harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: failure })),
        ]);
        const result = await run;
        expect(readAttemptTerminal(result).promptError).toBeTruthy();
        expect(result).toMatchObject({
          replayMetadata: { hadPotentialSideEffects: true, replaySafe: false },
        });
        expect(result.messagesSnapshot).toContainEqual(
          expect.objectContaining({ role: "toolResult", toolCallId: "tool-settled" }),
        );
        expect(harness.requests.filter((request) => request.method === "turn/start")).toHaveLength(
          1,
        );
        expect(harness.client.getCloseError()).toBeUndefined();
        if (!freshConnection) {
          expect(getCurrentSharedClientEntry(harness.client)).toBeDefined();
          return;
        }
        expect(getCurrentSharedClientEntry(harness.client)).toBeUndefined();
        // Existing siblings drain voluntarily before the saved native thread migrates.
        releaseSibling?.();
        const next = createStartedThreadHarness(
          async (method) =>
            method === "thread/resume" ? threadStartResult("thread-1") : undefined,
          { persistedThreads: ["thread-1"] },
        );
        const continuation = createParams(sessionFile, workspaceDir);
        await attachSqliteSessionTarget(
          continuation,
          path.join(tempDir, "transport-recovery.sqlite"),
          "session-transport-recovery",
        );
        continuation.runId = "transport-continuation";
        continuation.prompt =
          "Continue from the recorded result; do not repeat the completed tool.";
        const resumed = runCodexAppServerAttempt(continuation);
        await awaitGateBeforeSettlement(
          next.waitForMethod("turn/start"),
          resumed,
          "Continuation ended before starting the preserved thread",
        );
        expect(next.client).not.toBe(harness.client);
        _fixtures.expectResumeRequest(next.requests, { threadId: "thread-1" });
        expect(next.requests.filter((request) => request.method === "thread/start")).toHaveLength(
          0,
        );
        await next.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        expect((await resumed).terminal).toEqual({ kind: "ok" });
        expect(next.requests.filter((request) => request.method === "turn/start")).toHaveLength(1);
      } finally {
        releaseSibling?.();
      }
    },
  );
  it("preserves settled finalization eligibility after provider overload", async () => {
    const failure = {
      message: "Selected model is at capacity. Please try a different model.",
      codexErrorInfo: "serverOverloaded",
    };
    const { params, workspaceDir } = await settledParams(
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
      { onStart },
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
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    const emptyAssistant = { type: "agentMessage", id: "empty-assistant", text: "" };
    // Native events arrive in wire order; local projection must not delay terminal receipt.
    await Promise.all([
      harness.notify(itemNotification("item/started", emptyAssistant)),
      harness.notify(itemNotification("item/completed", emptyAssistant)),
      ...commandEvents(workspaceDir, "sent-to-alice").map((event) => harness.notify(event)),
      harness.notify(turnCompleted({ id: "turn-1", status: "failed", error: failure })),
    ]);
    const result = await run;
    const selectedProfile = "openai:ordered";
    expect(onStart).toHaveBeenCalledWith(selectedProfile, expect.anything(), expect.anything());
    expect(readAttemptTerminal(result).promptError).toMatchObject({
      message: failure.message,
      status: 503,
      code: "OVERLOADED",
    });
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
  });
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
