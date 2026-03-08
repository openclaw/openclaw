import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  clearActiveEmbeddedRun,
  getActiveEmbeddedRunCount,
  isEmbeddedPiRunActive,
  retainEmbeddedPiRunActivity,
  setActiveEmbeddedRun,
  waitForEmbeddedPiRunEnd,
} from "./runs.js";

function createHandle() {
  return {
    queueMessage: async (_text: string) => {},
    isStreaming: () => false,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded run activity holds", () => {
  it("keeps a session active until post-run activity is released", () => {
    const sessionId = `hold-${crypto.randomUUID()}`;
    const handle = createHandle();
    setActiveEmbeddedRun(sessionId, handle);
    const release = retainEmbeddedPiRunActivity(sessionId);

    clearActiveEmbeddedRun(sessionId, handle);

    expect(isEmbeddedPiRunActive(sessionId)).toBe(true);
    expect(getActiveEmbeddedRunCount()).toBeGreaterThanOrEqual(1);

    release();

    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });

  it("waits for post-run activity to finish before resolving run end", async () => {
    const sessionId = `wait-${crypto.randomUUID()}`;
    const handle = createHandle();
    setActiveEmbeddedRun(sessionId, handle);
    const release = retainEmbeddedPiRunActivity(sessionId);
    clearActiveEmbeddedRun(sessionId, handle);

    let settled = false;
    const waitPromise = waitForEmbeddedPiRunEnd(sessionId, 1_000).then((ended) => {
      settled = true;
      return ended;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    release();

    await expect(waitPromise).resolves.toBe(true);
    expect(isEmbeddedPiRunActive(sessionId)).toBe(false);
  });
});
