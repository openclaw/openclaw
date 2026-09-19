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
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt", () => {
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
