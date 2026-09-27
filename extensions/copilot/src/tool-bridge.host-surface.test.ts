import {
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotTestHostCapabilities } from "./host-capability.test-support.js";
import { createCopilotToolBridge } from "./tool-bridge.js";

const mocks = vi.hoisted(() => ({ publicFactory: vi.fn(() => []) }));
vi.mock("openclaw/plugin-sdk/agent-harness", () => ({
  createOpenClawCodingTools: mocks.publicFactory,
}));

afterEach(() => vi.clearAllMocks());

describe("Copilot host-owned tool construction", () => {
  it("uses the host-prepared reader without rebinding it or calling the public factory", async () => {
    let active = true;
    const reader = createOwnerBackedContractTool({
      pluginId: "fixture-owner",
      name: "read",
      result: textToolResult("HOST_PINNED_READER"),
    });
    reader.execute = vi.fn(async () => {
      if (!active) {
        throw new Error("host closed");
      }
      return textToolResult("HOST_PINNED_READER");
    });
    type HostCapabilities = ReturnType<typeof createCopilotTestHostCapabilities>;
    const createToolSurface = vi.fn<NonNullable<HostCapabilities["createToolSurface"]>>(() => [
      reader,
    ]);
    const bindToolSurface = vi.fn<HostCapabilities["bindToolSurface"]>(() => {
      throw new Error("Host-created tools must not be rebound");
    });
    const skillsSnapshot = { prompt: "", skills: [{ name: "manual" }], resolvedSkills: [] };
    const bridge = await createCopilotToolBridge({
      agentId: "main",
      modelProvider: "github-copilot",
      modelId: "test-model",
      sessionId: "session-1",
      workspaceDir: "/workspace",
      spawnWorkspaceDir: undefined,
      attemptParams: {
        config: { tools: { toolSearch: false } },
        codeModeOverride: false,
        skillsSnapshot,
        toolsAllow: ["read"],
        hostCapabilities: {
          ...createCopilotTestHostCapabilities(),
          createToolSurface,
          bindToolSurface,
        },
      },
    });
    expect(createToolSurface).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ skillsSnapshot, workspaceDir: "/workspace" }),
      { cwd: "/workspace" },
    );
    expect(mocks.publicFactory).not.toHaveBeenCalled();
    expect(bindToolSurface).not.toHaveBeenCalled();
    expect(bridge.sourceTools).toContain(reader);
    const sdkReader = bridge.promptToolPolicy.apply().tools.find((tool) => tool.name === "read");
    expect(sdkReader?.handler).toBeTypeOf("function");
    const invocation = {
      sessionId: "session-1",
      toolCallId: "read-1",
      toolName: "read",
      arguments: {},
    };
    const result = await sdkReader!.handler!({}, invocation);
    expect(result).toMatchObject({
      resultType: "success",
      textResultForLlm: expect.stringContaining("HOST_PINNED_READER"),
    });
    active = false;
    const rejected = await sdkReader!.handler!({}, { ...invocation, toolCallId: "read-closed" });
    expect(rejected).toMatchObject({
      resultType: "failure",
      error: expect.stringContaining("host closed"),
    });
    bridge.cleanup?.();
  });

  it("does not silently fall back to the public factory when host construction is unavailable", async () => {
    await expect(
      createCopilotToolBridge({
        agentId: "main",
        modelProvider: "github-copilot",
        modelId: "test-model",
        sessionId: "session-1",
        spawnWorkspaceDir: undefined,
        attemptParams: {
          codeModeOverride: false,
          hostCapabilities: createCopilotTestHostCapabilities(),
        },
      }),
    ).rejects.toThrow("Copilot tool construction requires a current host capability");
    expect(mocks.publicFactory).not.toHaveBeenCalled();
  });
});
