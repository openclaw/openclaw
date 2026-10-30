import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { prepareEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle-prepare.js";

it("retained transcript writers do not retain completed attempt continuations", async () => {
  async function completeAttempt() {
    const attempt = {
      config: {},
      runId: "retention",
      sessionId: "retention",
      sessionFile: "agent:main:retention",
      sessionKey: "agent:main:retention",
      sessionPersistence: "detached" as const,
      sessionTarget: {
        agentId: "main",
        sessionId: "retention",
        sessionKey: "agent:main:retention",
        storePath: "/tmp/retention-unused.sqlite",
      },
      continuation: {
        messages: [{ role: "user" as const, content: "First user turn", timestamp: 1 }],
        prompt: "continue",
      },
    };
    const prepared = await prepareEmbeddedAttemptTranscriptLifecycle({
      attempt,
      runAbortController: new AbortController(),
      externalAbortController: { arm() {}, async throwIfFiredAfterPrepCleanup() {} },
    });
    await prepared.withOwnedTranscriptWrite(async () => {});
    await prepared.transcriptLifecycle.dispose();
    return {
      writer: prepared.withOwnedTranscriptWrite,
      continuation: new WeakRef(attempt.continuation),
    };
  }
  const completed = await Promise.all(Array.from({ length: 20 }, completeAttempt));
  const control = new WeakRef({});
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(completed.filter(({ continuation }) => continuation.deref())).toHaveLength(0);
  await expect(completed[0]!.writer(async () => {})).rejects.toThrow("attempt disposed");
});
