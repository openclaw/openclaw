import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const createOpenClawKernelService = vi.fn();
  const OpenClawAgentAdapter = vi.fn();
  const desktopManager = {
    ensureDesktop: vi.fn(async () => undefined),
    resetDesktop: vi.fn(async () => undefined),
    getDesktop: vi.fn<(sessionKey: string) => { desktopId: string } | undefined>(() => undefined),
  };
  const kernel = {
    id: "kernel",
    reinitializeDesktopApps: vi.fn(async () => ({ reinitializedAppIds: [] })),
  };
  const service = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    isStarted: vi.fn(() => true),
    isEnabled: vi.fn(() => true),
    getKernel: vi.fn(() => kernel),
    getDesktopManager: vi.fn(() => desktopManager),
  };
  const adapterInstance = {
    install: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
  createOpenClawKernelService.mockImplementation(() => service);
  OpenClawAgentAdapter.mockImplementation(function MockOpenClawAgentAdapter() {
    return adapterInstance;
  });

  return {
    desktopManager,
    kernel,
    service,
    adapterInstance,
    createOpenClawKernelService,
    OpenClawAgentAdapter,
  };
});

vi.mock("./kernel-service.js", () => ({
  createOpenClawKernelService: mocks.createOpenClawKernelService,
}));

vi.mock("./agent-adapter.js", () => ({
  OpenClawAgentAdapter: mocks.OpenClawAgentAdapter,
}));

describe("AOTUI runtime registry", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.service.isEnabled.mockReturnValue(true);
    mocks.desktopManager.getDesktop.mockReturnValue(undefined);
    mocks.kernel.reinitializeDesktopApps.mockResolvedValue({ reinitializedAppIds: [] });
  });

  it("starts the gateway runtime once and reuses the same service", async () => {
    const runtime = await import("./runtime.js");
    const config = { aotui: { apps: { ide: { source: "npm:@agentina/aotui-ide" } } } };

    const first = await runtime.startAotuiGatewayRuntime(config as never);
    const second = await runtime.startAotuiGatewayRuntime();

    expect(first).toBe(second);
    expect(mocks.createOpenClawKernelService).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenClawKernelService).toHaveBeenCalledWith(config);
    expect(mocks.service.start).toHaveBeenCalledTimes(1);
  });

  it("resets the desktop for new sessions and ensures for existing sessions", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();

    await runtime.syncAotuiDesktopForRun({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      isNewSession: true,
    });

    await runtime.syncAotuiDesktopForRun({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_2",
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      isNewSession: false,
    });

    expect(mocks.desktopManager.resetDesktop).toHaveBeenCalledWith(
      "agent:main:discord:channel:dev",
      {
        sessionId: "session_1",
        agentId: "main",
        workspaceDir: "/tmp/workspace",
        reason: "session_reset",
      },
    );
    expect(mocks.desktopManager.ensureDesktop).toHaveBeenCalledWith({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_2",
      agentId: "main",
      workspaceDir: "/tmp/workspace",
    });
  });

  it("installs an OpenClaw agent adapter using the agent's current tools as base tools", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();
    const baseTool = { name: "read_file", execute: vi.fn() } as unknown as AgentTool;

    const agent = {
      state: { tools: [baseTool] },
      setTools: vi.fn(),
    };

    const adapter = await runtime.installAotuiAdapterForRun({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
      runId: "run_1",
      agent,
    });

    expect(adapter).toBe(mocks.adapterInstance);
    expect(mocks.OpenClawAgentAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:dev",
        sessionId: "session_1",
        agentId: "main",
        ownerId: "run_1",
        agent,
        baseTools: [baseTool],
      }),
    );
    expect(mocks.adapterInstance.install).toHaveBeenCalledTimes(1);
  });

  it("skips desktop sync and adapter install when Agent Apps are disabled", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();
    mocks.service.isEnabled.mockReturnValue(false);

    await runtime.syncAotuiDesktopForRun({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      isNewSession: false,
    });

    const adapter = await runtime.installAotuiAdapterForRun({
      sessionKey: "agent:main:discord:channel:dev",
      sessionId: "session_1",
      agentId: "main",
      runId: "run_1",
      agent: {
        state: { tools: [] },
        setTools: vi.fn(),
      },
    });

    expect(adapter).toBeNull();
    expect(mocks.desktopManager.ensureDesktop).not.toHaveBeenCalled();
    expect(mocks.OpenClawAgentAdapter).not.toHaveBeenCalled();
  });

  it("stops and clears the active runtime service", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();

    await runtime.stopAotuiGatewayRuntime("shutdown");

    expect(mocks.service.stop).toHaveBeenCalledWith("shutdown");
    expect(runtime.getAotuiGatewayRuntime()).toBeNull();
  });

  it("reinitializes the session desktop after compaction when a desktop exists", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();
    mocks.desktopManager.getDesktop.mockReturnValue({
      desktopId: "agent:main:discord:channel:dev",
    });

    const result = await runtime.reinitializeAotuiDesktopForCompaction({
      sessionKey: "agent:main:discord:channel:dev",
    });

    expect(result).toBe(true);
    expect(mocks.kernel.reinitializeDesktopApps).toHaveBeenCalledWith(
      "agent:main:discord:channel:dev",
      { reason: "context_compaction" },
    );
  });

  it("does not reinitialize when Agent Apps are disabled", async () => {
    const runtime = await import("./runtime.js");
    await runtime.startAotuiGatewayRuntime();
    mocks.service.isEnabled.mockReturnValue(false);
    mocks.desktopManager.getDesktop.mockReturnValue({
      desktopId: "agent:main:discord:channel:dev",
    });

    const result = await runtime.reinitializeAotuiDesktopForCompaction({
      sessionKey: "agent:main:discord:channel:dev",
    });

    expect(result).toBe(false);
    expect(mocks.kernel.reinitializeDesktopApps).not.toHaveBeenCalled();
  });
});
