import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexHostToolSurface } from "./host-tool-surface.js";

type HostCapabilities = NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;

function createHost(createToolSurface?: HostCapabilities["createToolSurface"]): HostCapabilities {
  return {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    ...(createToolSurface ? { createToolSurface } : {}),
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
  };
}

describe("Codex host tool construction", () => {
  it("declares per-result terminal completion", () => {
    const source: AnyAgentTool[] = [];
    const createToolSurface = vi.fn(() => source);

    expect(
      createCodexHostToolSurface({
        bindingOptions: { cwd: "/workspace" },
        hostCapabilities: createHost(createToolSurface),
        options: {},
      }),
    ).toBe(source);
    expect(createToolSurface).toHaveBeenCalledWith(
      {},
      { cwd: "/workspace" },
      { terminalCompletion: "per-result" },
    );
  });

  it("requires the host-owned constructor", () => {
    expect(() =>
      createCodexHostToolSurface({
        hostCapabilities: createHost(),
        options: {},
      }),
    ).toThrow("Codex tool construction requires a current host capability");
  });
});
