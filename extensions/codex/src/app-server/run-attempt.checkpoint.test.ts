import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { itemNotification, rawItemCompleted } from "./protocol.test-helpers.js";
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

describe("runCodexAppServerAttempt", () => {
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
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
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
    await vi.waitFor(async () => {
      expect(
        (await readTranscriptMessagesByIdentity(params)).map((message) => message.role),
      ).toEqual(["user", "assistant"]);
    });
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
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);
      await harness.waitForMethod("turn/start");
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
      // Startup notifications can be buffered until the prompt mirror finishes.
      const beforeRawOutput = await vi.waitFor(async () => {
        const messages = await readTranscriptMessagesByIdentity(params);
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        return messages;
      });
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
