import { describe, expect, it, beforeEach } from "vitest";
import {
  setAfterLlmCallGatePromise,
  checkAfterLlmCallGate,
  clearAfterLlmCallGate,
} from "./after-llm-call-gate.js";

describe("after-llm-call-gate (Promise-based)", () => {
  const sessionId = "test-session";

  beforeEach(() => {
    clearAfterLlmCallGate(sessionId);
  });

  it("returns blocked: false when no gate is set", async () => {
    const result = await checkAfterLlmCallGate(sessionId, "tool-1");
    expect(result.blocked).toBe(false);
  });

  it("blocks all tools when hook sets block: true", async () => {
    setAfterLlmCallGatePromise(sessionId, Promise.resolve({ block: true, blockReason: "policy" }));

    const result = await checkAfterLlmCallGate(sessionId, "any-tool");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("policy");
  });

  it("filters tools by ID when hook provides toolCalls list", async () => {
    setAfterLlmCallGatePromise(
      sessionId,
      Promise.resolve({ toolCalls: [{ id: "allowed-1" }, { id: "allowed-2" }] }),
    );

    expect((await checkAfterLlmCallGate(sessionId, "allowed-1")).blocked).toBe(false);
    expect((await checkAfterLlmCallGate(sessionId, "allowed-2")).blocked).toBe(false);

    const blocked = await checkAfterLlmCallGate(sessionId, "not-allowed");
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain("filtered");
  });

  it("blocks tool calls with no ID when filter is active", async () => {
    setAfterLlmCallGatePromise(sessionId, Promise.resolve({ toolCalls: [{ id: "only-this" }] }));

    const result = await checkAfterLlmCallGate(sessionId, undefined);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain("no ID");
  });

  it("first tool call awaits Promise; subsequent get cached result", async () => {
    let resolved = false;
    const slowPromise = new Promise<{ block: boolean }>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve({ block: false });
      }, 50);
    });

    setAfterLlmCallGatePromise(sessionId, slowPromise);

    // Start two checks concurrently
    const [result1, result2] = await Promise.all([
      checkAfterLlmCallGate(sessionId, "tool-1"),
      checkAfterLlmCallGate(sessionId, "tool-2"),
    ]);

    expect(resolved).toBe(true);
    expect(result1.blocked).toBe(false);
    expect(result2.blocked).toBe(false);
  });

  it("clears gate on clearAfterLlmCallGate", async () => {
    setAfterLlmCallGatePromise(sessionId, Promise.resolve({ block: true }));
    expect((await checkAfterLlmCallGate(sessionId, "x")).blocked).toBe(true);

    clearAfterLlmCallGate(sessionId);
    expect((await checkAfterLlmCallGate(sessionId, "x")).blocked).toBe(false);
  });

  it("fails open when hook Promise rejects", async () => {
    setAfterLlmCallGatePromise(sessionId, Promise.reject(new Error("hook error")));

    // Should not throw, should return blocked: false
    const result = await checkAfterLlmCallGate(sessionId, "tool-1");
    expect(result.blocked).toBe(false);
  });

  it("isolates gates by sessionId", async () => {
    const session1 = "session-1";
    const session2 = "session-2";

    setAfterLlmCallGatePromise(session1, Promise.resolve({ block: true }));
    setAfterLlmCallGatePromise(session2, Promise.resolve({ block: false }));

    expect((await checkAfterLlmCallGate(session1, "x")).blocked).toBe(true);
    expect((await checkAfterLlmCallGate(session2, "x")).blocked).toBe(false);

    clearAfterLlmCallGate(session1);
    clearAfterLlmCallGate(session2);
  });

  it("returns blocked: false for empty/undefined hook result", async () => {
    setAfterLlmCallGatePromise(sessionId, Promise.resolve(undefined));
    expect((await checkAfterLlmCallGate(sessionId, "x")).blocked).toBe(false);

    setAfterLlmCallGatePromise(sessionId, Promise.resolve({}));
    expect((await checkAfterLlmCallGate(sessionId, "x")).blocked).toBe(false);
  });
});
