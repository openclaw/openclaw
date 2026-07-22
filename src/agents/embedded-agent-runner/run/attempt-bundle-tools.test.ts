import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBundleLspToolRuntime: vi.fn(),
  getOrCreateSessionMcpRuntime: vi.fn(),
  materializeBundleMcpToolsForRun: vi.fn(),
  applyFinalEffectiveToolPolicy: vi.fn(),
}));

vi.mock("../../agent-bundle-lsp-runtime.js", () => ({
  createBundleLspToolRuntime: mocks.createBundleLspToolRuntime,
}));

vi.mock("../../agent-bundle-mcp-tools.js", () => ({
  getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun: mocks.materializeBundleMcpToolsForRun,
}));

vi.mock("../../runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: vi.fn(() => []),
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

describe("prepareEmbeddedAttemptBundleTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disposes prepared bundle runtimes when later policy setup fails", async () => {
    const disposeMcp = vi.fn(async () => {});
    const disposeLsp = vi.fn(async () => {});
    const onBundleMcpLeaseAcquired = vi.fn();
    const leaseHandle = { dispose: disposeMcp };
    const materializedMcpRuntime = {
      tools: [],
      dispose: disposeMcp,
    };
    mocks.getOrCreateSessionMcpRuntime.mockResolvedValue({});
    mocks.materializeBundleMcpToolsForRun.mockImplementation(
      async (params: { onLeaseAcquired?: (handle: typeof leaseHandle) => void }) => {
        params.onLeaseAcquired?.(leaseHandle);
        return materializedMcpRuntime;
      },
    );
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
        onBundleMcpLeaseAcquired,
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
    expect(onBundleMcpLeaseAcquired).toHaveBeenCalledWith(leaseHandle);
    expect(disposeMcp).toHaveBeenCalledOnce();
    expect(disposeLsp).toHaveBeenCalledOnce();
  });
});
