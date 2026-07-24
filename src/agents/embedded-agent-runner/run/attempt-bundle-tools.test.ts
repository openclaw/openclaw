import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  getOrCreateSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
  normalizeAgentRuntimeTools: vi.fn(({ tools }: { tools: unknown[] }) => tools),
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: mocks.createBundleLspToolRuntime,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../../runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: mocks.normalizeAgentRuntimeTools,
}));

vi.mock("../effective-tool-policy.js", () => ({
  applyFinalEffectiveToolPolicy: mocks.applyFinalEffectiveToolPolicy,
}));

vi.mock("./attempt-tool-construction-plan.js", () => ({
  applyEmbeddedAttemptToolsAllow: vi.fn((tools: unknown[]) => tools),
  shouldCreateBundleLspRuntimeForAttempt: vi.fn(() => true),
  shouldCreateBundleMcpRuntimeForAttempt: vi.fn(() => true),
}));

import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";

function makeTool(name: string) {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] })),
  };
}

describe("prepareEmbeddedAttemptBundleTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disposes prepared bundle runtimes when later policy setup fails", async () => {
    const disposeMcp = vi.fn(async () => {});
    const disposeLsp = vi.fn(async () => {});
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [],
      dispose: disposeMcp,
    });
    mocks.createBundleLspToolRuntime.mockResolvedValue({
      tools: [],
      dispose: disposeLsp,
    });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(() => {
      throw new Error("bundle policy failed");
    });

    const input = {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      effectiveWorkspace: "/tmp/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      getProviderRuntimeHandle: () => undefined,
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        effectiveToolsAllow: undefined,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: undefined,
        toolsEnabled: true,
        toolsRaw: [],
      },
      sessionAgentId: "main",
    } as unknown as Parameters<typeof prepareEmbeddedAttemptBundleTools>[0];

    await expect(prepareEmbeddedAttemptBundleTools(input)).rejects.toThrow("bundle policy failed");
    expect(mocks.applyFinalEffectiveToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/workspace" }),
    );
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });

  it("keeps core tools while adding final materialized tools to spawned-child inheritance", async () => {
    const inheritedToolAllowlist = ["read", "sessions_spawn"];
    const allowedMcpTool = makeTool("probe__search");
    const blockedMcpTool = makeTool("probe__delete");
    const quarantinedMcpTool = {
      ...makeTool("probe__quarantined"),
      parameters: { type: "array", items: { type: "number" } },
    };
    const allowedLspTool = makeTool("lsp_hover_typescript");
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockResolvedValue({
      tools: [allowedMcpTool, blockedMcpTool, quarantinedMcpTool],
      dispose: vi.fn(async () => {}),
    });
    mocks.createBundleLspToolRuntime.mockResolvedValue({
      tools: [allowedLspTool],
      dispose: vi.fn(async () => {}),
    });
    mocks.applyFinalEffectiveToolPolicy.mockImplementation(
      ({ bundledTools }: { bundledTools: Array<{ name: string }> }) =>
        bundledTools.filter((tool) => tool.name !== "probe__delete"),
    );

    const input = {
      agentDir: "/tmp/agent",
      attempt: {
        config: {},
        model: {},
        modelId: "model",
        provider: "provider",
        runId: "run",
        runtimePlan: {},
        sessionId: "session",
      },
      effectiveWorkspace: "/tmp/workspace",
      getCurrentAttemptPluginMetadataSnapshot: () => undefined,
      getProviderRuntimeHandle: () => undefined,
      isRawModelRun: false,
      preparedToolBase: {
        cronCreatorToolAllowlist: [],
        effectiveToolsAllow: undefined,
        inheritedToolAllowlist,
        localModelLeanPreserveToolNames: [],
        runtimeCapabilityProfile: {},
        toolsEnabled: true,
        toolsRaw: [makeTool("read"), makeTool("sessions_spawn")],
      },
      sessionAgentId: "main",
    } as unknown as Parameters<typeof prepareEmbeddedAttemptBundleTools>[0];

    const prepared = await prepareEmbeddedAttemptBundleTools(input);

    expect(prepared.uncompactedEffectiveTools.map((tool) => tool.name)).toEqual([
      "read",
      "sessions_spawn",
      "probe__search",
      "lsp_hover_typescript",
    ]);
    expect(inheritedToolAllowlist).toEqual([
      "read",
      "sessions_spawn",
      "probe__search",
      "lsp_hover_typescript",
    ]);
    expect(inheritedToolAllowlist).not.toContain("probe__delete");
    expect(inheritedToolAllowlist).not.toContain("probe__quarantined");
  });
});
