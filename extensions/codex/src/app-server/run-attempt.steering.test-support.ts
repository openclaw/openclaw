import path from "node:path";
import { expect, vi } from "vitest";
import {
  createParams,
  fastWait,
  queueActiveRunMessageForTest,
  tempDir,
} from "./run-attempt-test-harness.js";

let steeringSessionIndex = 0;

export function createSteeringParams() {
  const sessionId = `steering-session-${++steeringSessionIndex}`;
  const params = createParams(
    path.join(tempDir, `${sessionId}.jsonl`),
    path.join(tempDir, `${sessionId}-workspace`),
  );
  params.sessionId = sessionId;
  params.sessionKey = `agent:main:${sessionId}`;
  params.runId = `run-${sessionId}`;
  params.toolAuthorityFingerprint = `authority-${sessionId}`;
  params.model = { ...params.model, input: ["text", "image"] };
  return params;
}

export async function waitAndQueueActiveRunMessage(
  sessionId: string,
  text: string,
  options?: Parameters<typeof queueActiveRunMessageForTest>[2],
) {
  let queued = false;
  await vi.waitFor(() => {
    if (!queued) {
      queued = queueActiveRunMessageForTest(sessionId, text, options);
    }
    expect(queued).toBe(true);
  }, fastWait);
}
