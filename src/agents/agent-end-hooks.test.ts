import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "../hooks/internal-hooks.js";
import { triggerAgentEndHook } from "./agent-end-hooks.js";

describe("triggerAgentEndHook", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("fires an agent:end internal hook with correct context", async () => {
    let captured: InternalHookEvent | undefined;
    registerInternalHook("agent:end", (event) => {
      captured = event;
    });

    await triggerAgentEndHook({
      messages: [{ role: "user", content: "hello" }],
      success: true,
      durationMs: 1234,
      agentId: "test-agent",
      sessionKey: "sess-123",
      workspaceDir: "/tmp/workspace",
    });

    expect(captured).toBeDefined();
    expect(captured!.type).toBe("agent");
    expect(captured!.action).toBe("end");
    expect(captured!.sessionKey).toBe("sess-123");
    expect(captured!.context).toEqual({
      messages: [{ role: "user", content: "hello" }],
      success: true,
      durationMs: 1234,
      agentId: "test-agent",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("includes error in context when provided", async () => {
    let captured: InternalHookEvent | undefined;
    registerInternalHook("agent:end", (event) => {
      captured = event;
    });

    await triggerAgentEndHook({
      messages: [],
      success: false,
      error: "prompt timed out",
      durationMs: 60000,
      sessionKey: "sess-456",
      workspaceDir: "/tmp/workspace",
    });

    expect(captured).toBeDefined();
    expect(captured!.context).toEqual({
      messages: [],
      success: false,
      error: "prompt timed out",
      durationMs: 60000,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("does not throw when no handlers are registered", async () => {
    await expect(
      triggerAgentEndHook({
        messages: [],
        success: true,
        durationMs: 0,
        sessionKey: "sess-789",
        workspaceDir: "/tmp",
      }),
    ).resolves.not.toThrow();
  });
});
