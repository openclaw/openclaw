// Codex tests cover periodic Computer Use health monitoring.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { startCodexComputerUseHealthMonitor } from "./computer-use-health.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

describe("Codex Computer Use periodic health", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs the live list_apps probe on the configured cadence and clears on client close", async () => {
    vi.useFakeTimers();
    const client = createClient();

    const result = startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckIntervalMinutes: 30 }),
    });

    expect(result).toEqual({ started: true, intervalMs: 30 * 60_000 });
    expect(client.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(client.request).toHaveBeenCalledWith(
      "mcpServer/tool/call",
      {
        serverName: "computer-use",
        toolName: "list_apps",
        arguments: {},
      },
      { timeoutMs: 60_000 },
    );

    client.close();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it("repairs stale CUA children and retries once after a failed probe", async () => {
    vi.useFakeTimers();
    const client = createClient();
    client.request.mockRejectedValueOnce(new Error("hung")).mockResolvedValueOnce({ apps: [] });
    const repairComputerUseMcpChildren = vi.fn(async () => ({
      attempted: true,
      killedPids: [1234],
      warnings: [],
      message: "Terminated 1 stale Computer Use MCP child process.",
    }));

    startCodexComputerUseHealthMonitor({
      client: client.client,
      config: computerUseConfig({ healthCheckIntervalMinutes: 30 }),
      repairComputerUseMcpChildren,
    });

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(client.request).toHaveBeenCalledTimes(2);
    expect(repairComputerUseMcpChildren).toHaveBeenCalledTimes(1);
  });

  it("does not start when Computer Use is disabled", () => {
    const client = createClient();

    expect(
      startCodexComputerUseHealthMonitor({
        client: client.client,
        config: computerUseConfig({ enabled: false }),
      }),
    ).toEqual({ started: false, reason: "disabled" });
    expect(client.addCloseHandler).not.toHaveBeenCalled();
  });
});

function createClient() {
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  const client = {
    request: vi.fn(async () => ({ apps: [] })),
    addCloseHandler: vi.fn((handler: (client: CodexAppServerClient) => void) => {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    }),
  } as unknown as CodexAppServerClient;
  return {
    client,
    request: vi.mocked(client.request),
    addCloseHandler: vi.mocked(client.addCloseHandler),
    close: () => {
      for (const handler of closeHandlers) {
        handler(client);
      }
    },
  };
}

function computerUseConfig(
  overrides: Partial<ResolvedCodexComputerUseConfig> = {},
): ResolvedCodexComputerUseConfig {
  return {
    enabled: true,
    autoInstall: true,
    marketplaceDiscoveryTimeoutMs: 60_000,
    liveTestTimeoutMs: 60_000,
    toolCallTimeoutMs: 60_000,
    leaseTimeoutMs: 300_000,
    healthCheckIntervalMinutes: 60,
    pluginCacheMode: "symlink",
    fallbackOnFailure: false,
    autoRepair: true,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    ...overrides,
  };
}
