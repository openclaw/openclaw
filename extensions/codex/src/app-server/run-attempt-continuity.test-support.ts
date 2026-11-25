import assert from "node:assert/strict";
import { expect } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import { turnCompleted } from "./protocol.test-helpers.js";

export function runningCommand(id: string, command: string, processId: string | null) {
  return {
    type: "commandExecution",
    id,
    command,
    processId,
    cwd: "/workspace",
    status: "inProgress",
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
}

export function answerCompleted(text: string) {
  return turnCompleted({
    id: "turn-1",
    status: "completed",
    items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text }],
  });
}

export function requestParams(
  harness: { requests: ReadonlyArray<{ method: string; params?: unknown }> },
  method: string,
) {
  const params = harness.requests.find((entry) => entry.method === method)?.params;
  assert(isJsonObject(params), `Expected ${method} params`);
  return params;
}

/** Exercise the parent-only context boundary on an actual managed turn request. */
export function readManagedInstructions(client: CodexAppServerClient, request: unknown) {
  const route = getCodexInferenceThread(client, "thread-1");
  assert(route && isJsonObject(request) && isJsonObject(request.responsesapiClientMetadata));
  const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
  assert(typeof generation === "string");
  const nativeBody = { instructions: "Native model-owned policy", input: [] };
  const metadata = { requestKind: "turn", threadId: "thread-1", generation };
  const parent = route.context.prepare(nativeBody, metadata);
  parent.assertCurrent();
  const instructions = parent.body.instructions;
  assert(typeof instructions === "string");
  expect(route.context.prepare(nativeBody, metadata).body).toEqual(parent.body);
  expect(route.context.prepare(nativeBody, { ...metadata, requestKind: "compaction" }).body).toBe(
    nativeBody,
  );
  expect(
    route.context.prepare(nativeBody, {
      ...metadata,
      threadId: "child",
      parentThreadId: "thread-1",
    }).body,
  ).toBe(nativeBody);
  return instructions;
}

export function retainSourceAuthority(signal: AbortSignal, release = () => {}) {
  const assertCurrent = () => signal.throwIfAborted();
  return () => ({
    signal,
    modelPolicyRequired: false,
    bindModelExecution: () => ({ signal, assertCurrent, release: () => {} }),
    assertCurrent,
    release,
  });
}
