import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { JsonObject } from "./protocol.js";
import { itemNotification, rawItemCompleted, turnCompleted } from "./protocol.test-helpers.js";
import { observeAttemptProjectionReady } from "./run-attempt-lifecycle.test-support.js";
import {
  createParams,
  createTestParams,
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

setupRunAttemptTestHooks();

function agentMessage(id: string, phase: string, text: string) {
  return { type: "agentMessage", id, phase, text };
}
function commandExecution(id: string, aggregatedOutput: string) {
  return {
    type: "commandExecution",
    id,
    command: "transcript",
    status: "completed",
    aggregatedOutput,
    exitCode: 0,
  };
}

async function checkpointParams() {
  const params = createTestParams();
  await attachSqliteSessionTarget(params, path.join(tempDir, "sessions.sqlite"), params.sessionId);
  return params;
}

async function startCheckpointAttempt(params: ReturnType<typeof createParams>) {
  // Keep the attempt budget controlled while the real SQLite workers progress.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const waitForProjection = observeAttemptProjectionReady();
  const harness = createStartedThreadHarness();
  const run = runCodexAppServerAttempt(params);
  await Promise.race([
    waitForProjection(),
    run.then(() => {
      throw new Error("Codex attempt ended before projection activation");
    }),
  ]);
  // A turn/start request precedes the prompt mirror and notification binding.
  // Once ready, awaited notifications include their canonical checkpoint work.
  return {
    harness,
    run,
    raw: (item: JsonObject) => harness.notify(rawItemCompleted(item)),
    completed: (item: JsonObject) => harness.notify(itemNotification("item/completed", item)),
  };
}

describe("runCodexAppServerAttempt", () => {
  it("persists completed commentary and final once when native item IDs change after streaming", async () => {
    const params = await checkpointParams();
    const { harness, run, completed } = await startCheckpointAttempt(params);
    // Captured from pinned rust-v0.154.0: deltas retain the started ID,
    // item/completed has a new ID, and the terminal summary repeats that new ID.
    for (const phase of ["commentary", "final_answer"] as const) {
      const text = phase === "commentary" ? "Checking the workspace." : "The work is complete.";
      await harness.notify(
        itemNotification("item/started", agentMessage(`${phase}-preview`, phase, "")),
      );
      await harness.notify({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-1", turnId: "turn-1", itemId: `${phase}-preview`, delta: text },
      });
      await completed(agentMessage(`${phase}-completed`, phase, text));
    }
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "completed",
        items: [agentMessage("final_answer-completed", "final_answer", "The work is complete.")],
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
    expect(messages).not.toContainEqual(
      expect.objectContaining({
        __openclaw: expect.objectContaining({ mirrorIdentity: expect.stringContaining("preview") }),
      }),
    );
  });

  it("checkpoints the complete native response, not the earlier execution preview", async () => {
    const params = await checkpointParams();
    // Prepare the history reader before the attempt budget starts.
    await readCodexMirroredSessionHistoryMessages(params);
    const { harness, run, raw, completed } = await startCheckpointAttempt(params);
    await raw({
      type: "function_call",
      call_id: "long-command",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "transcript", max_output_tokens: 24_000 }),
    });
    await completed(commandExecution("long-command", "RAW STDOUT"));
    expect((await readTranscriptMessagesByIdentity(params)).map((message) => message.role)).toEqual(
      ["user", "assistant"],
    );
    const output = " \r\n" + "transcript 😀\n".repeat(12_000) + "END OF RESPONSE\r\n ";
    await raw({ type: "function_call_output", call_id: "long-command", output });
    const checkpoint = await readTranscriptMessagesByIdentity(params);
    expect(checkpoint[2]).toMatchObject({
      role: "toolResult",
      toolCallId: "long-command",
      content: [{ type: "text", text: output }],
      __openclaw: { toolOutput: { source: "provider-response", modelInput: "unverified" } },
    });
    await raw({
      type: "custom_tool_call",
      call_id: "outer-exec",
      name: "exec",
      input: "text(await tools.exec_command({cmd: 'transcript'}))",
    });
    await completed(commandExecution("nested-command", "nested stdout"));
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
    await raw({ type: "custom_tool_call_output", call_id: "outer-exec", output });
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

  it("checkpoints raw patch output and network provenance without persisting commentary", async () => {
    const params = await checkpointParams();
    params.config = { ...params.config, ui: { prefs: { chatPersistCommentary: false } } };
    const { harness, run, raw, completed } = await startCheckpointAttempt(params);
    const patchId = "patch-1";
    await raw({
      type: "custom_tool_call",
      call_id: patchId,
      name: "apply_patch",
      input: "*** Begin Patch\n*** Add File: example.txt\n+saved\n*** End Patch\n",
    });
    await completed({
      type: "fileChange",
      id: patchId,
      status: "completed",
      changes: [{ path: "example.txt", kind: { type: "add" } }],
    });
    const beforeRawOutput = await readTranscriptMessagesByIdentity(params);
    expect(beforeRawOutput.map((message) => message.role)).toEqual(["user", "assistant"]);
    await completed({
      type: "webSearch",
      id: "search-1",
      status: "completed",
      query: "saved file",
    });
    expect(await readTranscriptMessagesByIdentity(params)).toEqual(beforeRawOutput);
    await raw({
      type: "custom_tool_call_output",
      call_id: patchId,
      output: "Success. Updated the following files:\nA example.txt",
    });
    await completed(
      agentMessage("network-commentary", "commentary", "The search confirms the result."),
    );
    const checkpoint = await readTranscriptMessagesByIdentity(params);
    expect(checkpoint.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(checkpoint[2])).toContain("Success. Updated the following files:");
    expect(checkpoint[4]).toMatchObject({ __openclaw: { resultContentSource: "network" } });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await run;
    const finalMessages = await readTranscriptMessagesByIdentity(params);
    expect(new Set(finalMessages.map((message) => message.idempotencyKey)).size).toBe(
      checkpoint.length,
    );
    expect(finalMessages).toEqual(checkpoint);
  });
});
