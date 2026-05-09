import { describe, expect, it } from "vitest";
import { assertPreparedAgentRunSerializable, type PreparedAgentRun } from "./runtime-backend.js";

function createPreparedRun(overrides: Partial<PreparedAgentRun> = {}): PreparedAgentRun {
  return {
    runtimeId: "pi",
    runId: "run-1",
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    filesystemMode: "vfs-scratch",
    deliveryPolicy: { emitToolResult: false, emitToolOutput: false },
    ...overrides,
  };
}

describe("agent runtime backend contract", () => {
  it("accepts a structured-cloneable prepared run for worker handoff", () => {
    const run = createPreparedRun({
      config: { agents: { defaults: { model: "gpt-5.5" } } },
    });

    expect(assertPreparedAgentRunSerializable(run)).toBe(run);
  });

  it("rejects missing required fields", () => {
    expect(() => assertPreparedAgentRunSerializable(createPreparedRun({ runId: "" }))).toThrow(
      "runId",
    );
  });

  it("rejects non-serializable payloads", () => {
    expect(() =>
      assertPreparedAgentRunSerializable({
        ...createPreparedRun(),
        config: { bad: () => undefined } as unknown as PreparedAgentRun["config"],
      }),
    ).toThrow("structured-clone serializable");
  });
});
