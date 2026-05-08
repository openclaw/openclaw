import { describe, expect, it } from "vitest";
import type { AgentHarnessAttemptParams } from "./types.js";
import {
  collectAgentHarnessWorkerBlockers,
  resolveAgentHarnessWorkerLaunch,
} from "./worker-policy.js";

function createAttempt(
  overrides: Partial<AgentHarnessAttemptParams> = {},
): AgentHarnessAttemptParams {
  return {
    sessionId: "session-1",
    sessionFile: "sqlite-transcript://main/session-1.jsonl",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    runId: "run-1",
    provider: "openai",
    modelId: "gpt-5.5",
    thinkLevel: "medium",
    authStorage: undefined,
    authProfileStore: undefined,
    modelRegistry: undefined,
    model: undefined,
    ...overrides,
  } as AgentHarnessAttemptParams;
}

describe("agent harness worker policy", () => {
  it("rejects current PI attempt payloads that still carry live runtime objects", () => {
    const blockers = collectAgentHarnessWorkerBlockers(
      createAttempt({
        authStorage: { get: () => undefined } as never,
        modelRegistry: { list: () => [] } as never,
        model: { id: "gpt-5.5" } as never,
        onToolResult: () => undefined,
        onToolOutcome: () => undefined,
      }),
    );

    expect(blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "authStorage" }),
        expect.objectContaining({ field: "modelRegistry" }),
        expect.objectContaining({ field: "model" }),
        expect.objectContaining({ field: "onToolOutcome" }),
      ]),
    );
    expect(blockers).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ field: "onToolResult" })]),
    );
  });

  it("keeps auto mode inline until live runtime objects are removed", () => {
    expect(
      resolveAgentHarnessWorkerLaunch({
        env: { OPENCLAW_AGENT_WORKER_MODE: "auto" },
        attempt: createAttempt({
          authStorage: { get: () => undefined } as never,
        }),
      }),
    ).toMatchObject({
      mode: "inline",
      reason: "not_serializable",
      blockers: [expect.objectContaining({ field: "authStorage" })],
    });
  });

  it("allows worker launch for the reduced shape with parent-owned callback fields", () => {
    expect(
      resolveAgentHarnessWorkerLaunch({
        env: { OPENCLAW_AGENT_WORKER_MODE: "auto" },
        attempt: createAttempt({
          abortSignal: new AbortController().signal,
          hasRepliedRef: { value: false },
          onExecutionStarted: () => undefined,
          onToolResult: () => undefined,
          shouldEmitToolResult: () => true,
        }),
      }),
    ).toEqual({ mode: "worker", reason: "serializable" });
  });

  it("fails closed when worker mode is forced for a non-serializable attempt", () => {
    expect(() =>
      resolveAgentHarnessWorkerLaunch({
        env: { OPENCLAW_AGENT_WORKER_MODE: "worker" },
        attempt: createAttempt({
          onToolOutcome: () => undefined,
        }),
      }),
    ).toThrow(/not worker-serializable/);
  });
});
