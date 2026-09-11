import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { bindNewCopilotTools, createCopilotHostToolSurface } from "./tool-bridge-host-tools.js";

type HostCapabilities = NonNullable<AgentHarnessAttemptParamsV2["hostCapabilities"]>;

function createTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute: async () => ({ content: [], details: {} }),
  } as AnyAgentTool;
}

function createHost(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
  return {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
    requestApproval: async () => undefined,
    waitForApproval: async () => undefined,
    ...overrides,
  };
}

describe("Copilot host tool construction", () => {
  it("uses the host-owned constructor without rebinding its returned tools", async () => {
    const source = createTool("probe");
    const createToolSurface = vi.fn(() => [source]);
    const bindToolSurface = vi.fn((tools: AnyAgentTool[]) => tools);
    const factory = vi.fn(async () => [createTool("legacy")]);

    const tools = await createCopilotHostToolSurface({
      factory,
      hostCapabilities: createHost({ bindToolSurface, createToolSurface }),
      options: {},
    });

    expect(tools).toEqual([source]);
    expect(createToolSurface).toHaveBeenCalledWith({}, undefined);
    expect(createToolSurface.mock.calls[0]).toHaveLength(2);
    expect(bindToolSurface).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps the published-host fallback behind binding without terminal authority", async () => {
    const source = createTool("read");
    const bound = createTool("bound");
    const bindToolSurface = vi.fn(() => [bound]);

    const tools = await createCopilotHostToolSurface({
      factory: async () => [source],
      hostCapabilities: createHost({ bindToolSurface }),
      options: {},
    });

    expect(tools).toEqual([bound]);
    expect(bindToolSurface).toHaveBeenCalledWith([source], undefined);
    expect(bindToolSurface.mock.calls[0]).toHaveLength(2);
    expect(tools.some((tool) => tool.name === "send_current_reply")).toBe(false);
  });

  it("binds only controls created after host construction", () => {
    const retained = createTool("retained");
    const control = createTool("control");
    const boundControl = createTool("bound-control");
    const bindToolSurface = vi.fn(() => [boundControl]);

    expect(
      bindNewCopilotTools({
        compactedTools: [retained, control],
        hostCapabilities: createHost({ bindToolSurface }),
        previouslyBound: new Set([retained]),
      }),
    ).toEqual([retained, boundControl]);
    expect(bindToolSurface).toHaveBeenCalledWith([control], undefined);
  });
});
