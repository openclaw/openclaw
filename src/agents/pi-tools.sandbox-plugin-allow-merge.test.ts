import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", () => ({
  getOAuthApiKey: () => undefined,
  getOAuthProviders: () => [],
}));

const { mockApplyToolPolicyPipeline, mockBuildDefaultToolPolicyPipelineSteps } = vi.hoisted(() => ({
  mockApplyToolPolicyPipeline: vi.fn((args: { tools: unknown[] }) => args.tools),
  mockBuildDefaultToolPolicyPipelineSteps: vi.fn(() => []),
}));

vi.mock("./tool-policy-pipeline.js", () => ({
  applyToolPolicyPipeline: mockApplyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps: mockBuildDefaultToolPolicyPipelineSteps,
}));

vi.mock("../plugins/tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/tools.js")>();
  return {
    ...actual,
    getPluginToolMeta: (tool: { name: string }) =>
      tool.name === "read" ? { pluginId: "test-plugin", optional: false } : undefined,
  };
});

import { computeSandboxStepPolicy, createOpenClawCodingTools } from "./pi-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type DummyTool = { name: string };

/** Minimal tool shape for policy tests; computeSandboxStepPolicy only uses .name and toolMeta(tool). */
function asTools(tools: DummyTool[]): AnyAgentTool[] {
  return tools as unknown as AnyAgentTool[];
}

function createSandboxForTest() {
  return {
    enabled: true,
    sessionKey: "agent:test:slack:dm:u1",
    // Keep workspaceDir empty to avoid requiring fsBridge in this policy-focused test.
    workspaceDir: "",
    agentWorkspaceDir: "/tmp/openclaw-test-workspace",
    workspaceAccess: "rw",
    containerName: "sandbox-test",
    containerWorkdir: "/workspace",
    docker: { env: {} },
    tools: { allow: ["gateway"] },
    browserAllowHostControl: false,
  };
}

/**
 * Unit tests for computeSandboxStepPolicy with explicit fixtures. No dependency on
 * createOpenClawCodingTools base tool list or pipeline; covers the pluginAllow merge
 * code path directly.
 */
describe("computeSandboxStepPolicy", () => {
  it("returns sandboxTools when allow is missing or empty", () => {
    const tools = asTools([{ name: "start_task" }]);
    const toolMeta = (t: AnyAgentTool) =>
      t.name === "start_task" ? { pluginId: "p1" } : undefined;
    expect(
      computeSandboxStepPolicy({
        sandboxTools: undefined,
        explicitProfileAlsoAllow: ["start_task"],
        tools,
        toolMeta,
      }),
    ).toBeUndefined();
    expect(
      computeSandboxStepPolicy({
        sandboxTools: { allow: [], deny: [] },
        explicitProfileAlsoAllow: ["start_task"],
        tools,
        toolMeta,
      })?.allow,
    ).toEqual([]);
  });

  it("returns sandboxTools when explicitProfileAlsoAllow has no plugin tools in tool set", () => {
    const tools = asTools([{ name: "read" }]);
    const toolMeta = () => undefined;
    const sandboxTools = { allow: ["read"] };
    const result = computeSandboxStepPolicy({
      sandboxTools,
      explicitProfileAlsoAllow: ["start_task"],
      tools,
      toolMeta,
    });
    expect(result).toBe(sandboxTools);
  });

  it("merges sandbox allow with plugin-only names from explicit alsoAllow (explicit fixtures)", () => {
    const tools = asTools([{ name: "read" }, { name: "start_task" }]);
    const toolMeta = (t: AnyAgentTool) =>
      t.name === "start_task" ? { pluginId: "workflow" } : undefined;
    const result = computeSandboxStepPolicy({
      sandboxTools: { allow: ["read", "exec"] },
      explicitProfileAlsoAllow: ["start_task"],
      tools,
      toolMeta,
    });
    expect(result).toBeDefined();
    expect(result!.allow?.toSorted()).toEqual(["exec", "read", "start_task"]);
    expect(result!.deny).toBeUndefined();
  });

  it("does not merge core-only names from alsoAllow when they are not plugin tools", () => {
    const tools = asTools([{ name: "read" }, { name: "start_task" }]);
    const toolMeta = (t: AnyAgentTool) =>
      t.name === "start_task" ? { pluginId: "p1" } : undefined;
    const result = computeSandboxStepPolicy({
      sandboxTools: { allow: ["read"] },
      explicitProfileAlsoAllow: ["read", "exec", "start_task"],
      tools,
      toolMeta,
    });
    expect(result!.allow?.toSorted()).toEqual(["read", "start_task"]);
  });

  it("matches plugin tools via wildcard alsoAllow patterns", () => {
    const tools = asTools([{ name: "start_task" }, { name: "start_other" }, { name: "stop_task" }]);
    const toolMeta = (t: AnyAgentTool) =>
      t.name === "start_task" || t.name === "start_other" ? { pluginId: "p1" } : undefined;
    const result = computeSandboxStepPolicy({
      sandboxTools: { allow: ["gateway"] },
      explicitProfileAlsoAllow: ["start_*"],
      tools,
      toolMeta,
    });
    expect(result).toBeDefined();
    const allow = result!.allow?.toSorted();
    expect(allow).toEqual(["gateway", "start_other", "start_task"]);
  });
});

/**
 * Integration path: createOpenClawCodingTools with sandbox + alsoAllow; asserts the
 * sandbox step receives the merged allow. Pipeline is mocked so we only verify the
 * policy passed to the sandbox step.
 */
describe("sandbox plugin allow merge", () => {
  it("merges only plugin-resolved explicit alsoAllow entries into sandbox allow", () => {
    mockApplyToolPolicyPipeline.mockClear();
    const workspaceDir = "/tmp/openclaw-test-workspace";

    createOpenClawCodingTools({
      workspaceDir,
      // oxlint-disable-next-line typescript/no-explicit-any -- test fixture
      sandbox: createSandboxForTest() as any,
      // oxlint-disable-next-line typescript/no-explicit-any -- test fixture
      config: { tools: { profile: "messaging", alsoAllow: ["read", "exec"] } } as any,
    });

    expect(mockApplyToolPolicyPipeline).toHaveBeenCalled();
    const lastCall = mockApplyToolPolicyPipeline.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const args = lastCall![0] as unknown as {
      steps: Array<{ label: string; policy?: { allow?: string[] } }>;
    };
    const sandboxStep = args.steps.find((step) => step.label === "sandbox tools.allow");
    expect(sandboxStep).toBeDefined();
    expect(sandboxStep!.policy).toBeDefined();
    expect(sandboxStep!.policy!.allow).toBeDefined();

    const allow = sandboxStep!.policy!.allow!.toSorted();
    // sandbox allow list ["gateway"] merged with plugin-resolved explicit alsoAllow ["read"]
    expect(allow).toEqual(["gateway", "read"]);
    // exec is in explicit alsoAllow but not plugin-resolved via getPluginToolMeta
    expect(allow).not.toContain("exec");
  });

  /**
   * Expands plugin-id selectors (e.g. alsoAllow: ["test-plugin"]) via expandPluginGroups
   * before merging into sandbox allow.
   * Fixture: getPluginToolMeta is mocked so the tool named "read" is the only plugin tool
   * (pluginId "test-plugin"). Guard assertion ensures the base tool list includes "read".
   */
  it("expands plugin-id selectors in explicit alsoAllow before sandbox merge", () => {
    mockApplyToolPolicyPipeline.mockClear();
    const workspaceDir = "/tmp/openclaw-test-workspace";

    createOpenClawCodingTools({
      workspaceDir,
      // oxlint-disable-next-line typescript/no-explicit-any -- test fixture
      sandbox: createSandboxForTest() as any,
      // oxlint-disable-next-line typescript/no-explicit-any -- test fixture
      config: { tools: { profile: "messaging", alsoAllow: ["test-plugin"] } } as any,
    });

    expect(mockApplyToolPolicyPipeline).toHaveBeenCalled();
    const lastCall = mockApplyToolPolicyPipeline.mock.calls.at(-1);
    expect(lastCall).toBeDefined();

    const args = lastCall![0] as unknown as {
      tools: Array<{ name: string }>;
      steps: Array<{ label: string; policy?: { allow?: string[] } }>;
    };
    const baseToolNames = args.tools.map((t) => t.name);
    expect(
      baseToolNames,
      "Fixture requires 'read' in the messaging profile tool list; update mock or fixture if profile changes.",
    ).toContain("read");

    const sandboxStep = args.steps.find((step) => step.label === "sandbox tools.allow");
    expect(sandboxStep).toBeDefined();
    expect(sandboxStep!.policy).toBeDefined();
    expect(sandboxStep!.policy!.allow).toBeDefined();

    const allow = sandboxStep!.policy!.allow!.toSorted();
    expect(allow).toEqual(["gateway", "read"]);
  });
});
