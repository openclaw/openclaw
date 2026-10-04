import { afterEach, expect, test } from "vitest";
import {
  createReplyOperation,
  retainReplyOperationUntilComplete,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
  waitForEmbeddedAgentRunEnd,
} from "./runs.js";
import { createEmbeddedRunHandle, testing } from "./runs.test-support.js";

const sessionId = "reset-preservation";
const sessionKey = "agent:main:reset-preservation";
afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetReplyRunRegistry();
});

test("preserving an old reply never exempts its same-session replacement from cancellation or drain", async () => {
  const previous = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  previous.complete();
  const replacement = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  retainReplyOperationUntilComplete(replacement);
  try {
    expect(isEmbeddedAgentRunActive(sessionId, previous)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId, { preserveReplyRun: previous })).toBe(true);
    expect(replacement.abortSignal.aborted).toBe(true);
    let drained = false;
    const pending = waitForEmbeddedAgentRunEnd(sessionId, null, previous).then((ended) => {
      drained = ended;
      return ended;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    replacement.complete();
    expect(await pending).toBe(true);
  } finally {
    replacement.complete();
  }
});

test("preserving the command reply still aborts and drains an embedded owner", async () => {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  let aborted = false;
  const handle = createEmbeddedRunHandle({
    abort: () => {
      aborted = true;
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    },
  });
  setActiveEmbeddedRun(sessionId, handle, sessionKey);
  try {
    expect(isEmbeddedAgentRunActive(sessionId, operation)).toBe(true);
    expect(abortEmbeddedAgentRun(sessionId, { preserveReplyRun: operation })).toBe(true);
    expect(aborted).toBe(true);
    expect(operation.abortSignal.aborted).toBe(false);
    expect(await waitForEmbeddedAgentRunEnd(sessionId, null, operation)).toBe(true);
    expect(isEmbeddedAgentRunActive(sessionId, operation)).toBe(false);
  } finally {
    operation.complete();
  }
});
