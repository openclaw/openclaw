import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import * as attemptActiveTurn from "./run-attempt-active-turn.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

setupRunAttemptTestHooks();

async function startCheckpointAttempt(params: ReturnType<typeof createParams>) {
  // Keep the attempt budget controlled while the real SQLite workers progress.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const activate = attemptActiveTurn.activateCodexAttemptTurn;
  const activated = createDeferred<ReturnType<typeof activate>>();
  vi.spyOn(attemptActiveTurn, "activateCodexAttemptTurn").mockImplementation((...args) => {
    const turn = activate(...args);
    activated.resolve(turn);
    return turn;
  });
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  const turn = await Promise.race([
    activated.promise,
    run.then(() => {
      throw new Error("Codex attempt ended before projection activation");
    }),
  ]);
  // A turn/start request precedes the prompt mirror and notification binding.
  // Once ready, awaited notifications include their canonical checkpoint work.
  await turn.ready;
  return { harness, run };
}

describe("runCodexAppServerAttempt", () => {
  it("persists completed commentary and final once when native item IDs change after streaming", async () => {
    const params = createParams(
      path.join(tempDir, "identity-drift.jsonl"),
      path.join(tempDir, "workspace"),
    );
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "identity-drift-sessions.json"),
      "identity-drift-session",
    );
    const { harness, run } = await startCheckpointAttempt(params);
    // Captured from pinned rust-v0.154.0: deltas retain the started ID,
    // item/completed has a new ID, and the terminal summary repeats that new ID.
    for (const phase of ["commentary", "final_answer"] as const) {
      const text = phase === "commentary" ? "Checking the workspace." : "The work is complete.";
      await harness.notify(
        itemNotification("item/started", {
          type: "agentMessage",
          id: `${phase}-preview`,
          phase,
          text: "",
        }),
      );
      await harness.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: `${phase}-preview`, delta: text },
      });
      await harness.notify(
        itemNotification("item/completed", {
          type: "agentMessage",
          id: `${phase}-completed`,
          phase,
          text,
        }),
      );
    }
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "completed",
        items: [
          {
            type: "agentMessage",
            id: "final_answer-completed",
            phase: "final_answer",
            text: "The work is complete.",
          },
        ],
      }),
    );
    await run;
    const messages = await readTranscriptMessagesByIdentity(params);
    expect(
      messages.filter((message) => message.role === "assistant").map((message) => message.content),
    ).toEqual([
      [{ type: "text", text: "Checking the workspace." }],
      [{ type: "text", text: "The work is complete." }],
    ]);
    expect(messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          __openclaw: expect.objectContaining({
            mirrorIdentity: expect.stringContaining("preview"),
          }),
        }),
      ]),
    );
  });

  it("checkpoints the complete native response, not the earlier execution preview", async () => {
    const params = createParams(
      path.join(tempDir, "output.jsonl"),
      path.join(tempDir, "workspace"),
    );
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "output-sessions.json"),
      "output-session",
    );
    // Prepare the history reader before the attempt budget starts.
    await readCodexMirroredSessionHistoryMessages(params);
    const { harness, run } = await startCheckpointAttempt(params);
    await harness.notify(
      rawItemCompleted({
        type: "function_call",
        call_id: "long-command",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "transcript", max_output_tokens: 24_000 }),
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "commandExecution",
        id: "long-command",
        command: "transcript",
        status: "completed",
        aggregatedOutput: "RAW STDOUT",
        exitCode: 0,
      }),
    );
    expect((await readTranscriptMessagesByIdentity(params)).map((message) => message.role)).toEqual(
      ["user", "assistant"],
    );
    const output = " \r\n" + "transcript 😀\n".repeat(12_000) + "END OF RESPONSE\r\n ";
    await harness.notify(
      rawItemCompleted({ type: "function_call_output", call_id: "long-command", output }),
    );
    const checkpoint = await readTranscriptMessagesByIdentity(params);
    expect(checkpoint[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "long-command",
      content: [{ type: "text", text: output }],
      __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
    });
    await harness.notify(
      rawItemCompleted({
        type: "custom_tool_call",
        call_id: "outer-exec",
        name: "exec",
        input: "text(await tools.exec_command({cmd: 'transcript'}))",
      }),
    );
    await harness.notify(
      itemNotification("item/completed", {
        type: "commandExecution",
        id: "nested-command",
        command: "transcript",
        status: "completed",
        aggregatedOutput: "nested stdout",
        exitCode: 0,
      }),
    );
    // Nested native execution has no model-response ID of its own. It must
    // checkpoint without waiting for the outer Code Mode response.
    expect(await readTranscriptMessagesByIdentity(params)).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "nested-command",
        __openclaw: expect.objectContaining({
          toolOutput: { source: "execution", modelInput: "unverified" },
        }),
      }),
    );
    await harness.notify(
      rawItemCompleted({ type: "custom_tool_call_output", call_id: "outer-exec", output }),
    );
    expect(await readTranscriptMessagesByIdentity(params)).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "outer-exec",
        content: [{ type: "text", text: output }],
      }),
    );
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    // A fresh canonical SQLite read must retain the enriched checkpoint. The
    // terminal mirror's idempotency hit must not resurrect the earlier stdout.
    expect((await readTranscriptMessagesByIdentity(params))[2]).toEqual(checkpoint[2]);
  });

  it.each([true, false])(
    "checkpoints raw patch output and network provenance with commentary persistence %s",
    async (persistCommentary) => {
      const params = createParams(
        path.join(tempDir, "checkpoint.jsonl"),
        path.join(tempDir, "workspace"),
      );
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "checkpoint-sessions.json"),
        "checkpoint-session",
      );
      params.config = {
        ...params.config,
        ui: { prefs: { chatPersistCommentary: persistCommentary } },
      };
      const { harness, run } = await startCheckpointAttempt(params);
      const patchId = "patch-1";
      await harness.notify(
        rawItemCompleted({
          type: "custom_tool_call",
          call_id: patchId,
          name: "apply_patch",
          input: "*** Begin Patch\n*** Add File: example.txt\n+saved\n*** End Patch\n",
        }),
      );
      await harness.notify(
        itemNotification("item/completed", {
          type: "fileChange",
          id: patchId,
          status: "completed",
          changes: [{ path: "example.txt", kind: { type: "add" } }],
        }),
      );
      const beforeRawOutput = await readTranscriptMessagesByIdentity(params);
      expect(beforeRawOutput.map((message) => message.role)).toEqual(["user", "assistant"]);
      await harness.notify(
        itemNotification("item/completed", {
          type: "webSearch",
          id: "search-1",
          status: "completed",
          query: "saved file",
        }),
      );
      expect(await readTranscriptMessagesByIdentity(params)).toEqual(beforeRawOutput);
      await harness.notify(
        rawItemCompleted({
          type: "custom_tool_call_output",
          call_id: patchId,
          output: "Success. Updated the following files:\nA example.txt",
        }),
      );
      await harness.notify(
        itemNotification("item/completed", {
          type: "agentMessage",
          id: "network-commentary",
          phase: "commentary",
          text: "The search confirms the result.",
        }),
      );
      const checkpoint = await readTranscriptMessagesByIdentity(params);
      expect(checkpoint.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        ...(persistCommentary ? ["assistant"] : []),
      ]);
      expect(JSON.stringify(checkpoint[2])).toContain("Success. Updated the following files:");
      expect(checkpoint[4]).toMatchObject({ __openclaw: { resultContentSource: "network" } });
      if (persistCommentary) {
        expect(checkpoint[5]).toMatchObject({ __openclaw: { turnTainted: true } });
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      const finalMessages = await readTranscriptMessagesByIdentity(params);
      for (const message of checkpoint) {
        expect(
          finalMessages.filter((candidate) => candidate.idempotencyKey === message.idempotencyKey),
        ).toEqual([message]);
      }
      if (persistCommentary) {
        expect(
          result.messagesSnapshot.find(
            (message) => readMirrorIdentity(message) === "turn-1:commentary:network-commentary",
          ),
        ).toMatchObject({
          __openclaw: { turnTainted: true },
        });
      }
    },
  );
});
