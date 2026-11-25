import path from "node:path";
import { expect, vi } from "vitest";
import type { CodexSteeringQueueOptions } from "./attempt-steering.js";
import {
  createParams,
  fastWait,
  queueActiveRunMessageForTest,
  tempDir,
} from "./run-attempt-test-harness.js";

let steeringSessionIndex = 0;

type SteeringRecorder = NonNullable<CodexSteeringQueueOptions["userTurnTranscriptRecorder"]>;

export function createSteeringRecorder<Message extends NonNullable<SteeringRecorder["message"]>>(
  message: Message,
  persistApproved: () => Promise<undefined>,
  hasPersisted: () => boolean,
) {
  return {
    message,
    resolveMessage: async () => message,
    getAdmissionReceipt: () => undefined,
    markRuntimePersistencePending: vi.fn(),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    isBlocked: () => false,
    hasRuntimePersistencePending: () => false,
    waitForRuntimePersistence: async () => {},
    persistBlocked: async () => undefined,
    persistFallback: async () => undefined,
    persistApproved: vi.fn(persistApproved),
    hasPersisted,
  } satisfies SteeringRecorder;
}

export function createSteeringParams() {
  const sessionId = `steering-session-${++steeringSessionIndex}`;
  const params = createParams(
    path.join(tempDir, `${sessionId}.jsonl`),
    path.join(tempDir, `${sessionId}-workspace`),
  );
  params.sessionId = sessionId;
  params.sessionKey = `agent:main:${sessionId}`;
  params.runId = `run-${sessionId}`;
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
