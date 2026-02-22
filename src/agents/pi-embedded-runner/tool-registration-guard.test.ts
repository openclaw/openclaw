import { describe, expect, it, vi } from "vitest";
import { installToolRegistrationGuard } from "./tool-registration-guard.js";

function makeTool(name: string) {
  return { name, execute: vi.fn() };
}

function makeFakeAgent(tools: unknown[]) {
  const state = { tools: [...tools] };
  const agent = {
    get state() {
      return state;
    },
    setTools(t: unknown[]) {
      state.tools = t;
    },
  };
  return agent;
}

describe("installToolRegistrationGuard", () => {
  it("freezes the tools array to prevent in-place mutation", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "write", "exec"],
    });

    expect(() => {
      agent.state.tools.push(makeTool("extra"));
    }).toThrow();

    expect(() => {
      agent.state.tools.length = 0;
    }).toThrow();
  });

  it("rejects setTools([]) when snapshot has tools", () => {
    const tools = [makeTool("read"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "exec"],
    });

    agent.setTools([]);
    // Tools should NOT have been cleared
    expect(agent.state.tools.length).toBe(2);
  });

  it("allows setTools with non-empty arrays", () => {
    const tools = [makeTool("read"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "exec"],
    });

    const newTools = [makeTool("read"), makeTool("exec"), makeTool("write")];
    agent.setTools(newTools);
    expect(agent.state.tools.length).toBe(3);
  });

  it("validateBeforePrompt restores tools from snapshot when array is empty", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    const { validateBeforePrompt } = installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "write", "exec"],
    });

    // Simulate direct _state.tools replacement bypassing setTools guard
    // (e.g. from SDK internals)
    (agent.state as { tools: unknown[] }).tools = [];
    validateBeforePrompt();

    expect(agent.state.tools.length).toBe(3);
    expect((agent.state.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "read",
      "write",
      "exec",
    ]);
  });

  it("validateBeforePrompt restores when expected tools are missing", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    const { validateBeforePrompt } = installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "write", "exec"],
    });

    // Simulate partial tool loss
    (agent.state as { tools: unknown[] }).tools = [makeTool("read")];
    validateBeforePrompt();

    expect(agent.state.tools.length).toBe(3);
  });

  it("validateBeforePrompt does nothing when all tools present", () => {
    const tools = [makeTool("read"), makeTool("write"), makeTool("exec")];
    const agent = makeFakeAgent(tools);

    const { validateBeforePrompt } = installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read", "write", "exec"],
    });

    validateBeforePrompt();
    expect(agent.state.tools.length).toBe(3);
  });

  it("dispose restores original setTools", () => {
    const tools = [makeTool("read")];
    const agent = makeFakeAgent(tools);
    const { dispose } = installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read"],
    });

    // The guarded setTools should reject empty arrays
    agent.setTools([]);
    expect(agent.state.tools.length).toBe(1);

    // After dispose, original setTools behavior is restored
    dispose();
    agent.setTools([]);
    expect(agent.state.tools.length).toBe(0);
  });

  it("re-freezes after valid setTools call", () => {
    const tools = [makeTool("read")];
    const agent = makeFakeAgent(tools);

    installToolRegistrationGuard({
      agent: agent as never,
      expectedToolNames: ["read"],
    });

    const newTools = [makeTool("read"), makeTool("exec")];
    agent.setTools(newTools);

    expect(() => {
      agent.state.tools.push(makeTool("extra"));
    }).toThrow();
  });
});
