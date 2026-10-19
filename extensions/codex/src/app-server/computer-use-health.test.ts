import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { startCodexComputerUseHealthMonitor } from "./computer-use-health.js";
import { createComputerUseRequest } from "./computer-use.test-support.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

describe("Codex Computer Use periodic health", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs the live list_apps probe on the configured cadence and clears on client close", async () => {
    const client = createClient();

    startMonitor(client);
    expect(client.request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(client.request).toHaveBeenCalledWith(
      "thread/start",
      {
        input: [],
        developerInstructions: "OpenClaw Computer Use readiness check",
        ephemeral: true,
      },
      { timeoutMs: 60_000 },
    );
    expectProbe(client, "computer-use", "list_apps", {}, 60_000);

    client.close();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expectToolCalls(client, 1);
  });

  it("reloads the owner-managed MCP runtime and retries once after a failed probe", async () => {
    const client = createClient({ liveTestFailures: 1 });

    startMonitor(client, { autoRepair: true });

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expectToolCalls(client, 2);
    expect(client.request).toHaveBeenCalledWith("config/mcpServer/reload", undefined, {
      timeoutMs: 60_000,
    });
  });

  it.each([
    { config: { healthCheckEnabled: false }, reason: "health_disabled" },
    { config: { enabled: false, healthCheckEnabled: true }, reason: "disabled" },
  ])("stops an existing monitor when $reason", async ({ config }) => {
    const client = createClient();
    startMonitor(client);
    startMonitor(client, config);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(client.request).not.toHaveBeenCalled();
  });

  it("replaces a same-interval monitor and probes the new unified tool configuration", async () => {
    const tools = ["js", "js_reset", "turn_ended"];
    const client = createClient({ mcpServerName: "cua_repl", mcpTools: tools });

    startMonitor(client);
    startMonitor(
      client,
      {
        pluginName: "unified-computer-use",
        mcpServerName: "cua_repl",
        toolCallTimeoutMs: 45_000,
      },
      tools,
    );

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expectProbe(client, "cua_repl", "js", { code: "await cua.listApps();" }, 45_000);
    expectToolCalls(client, 1);
  });
});

function createClient(
  options: { liveTestFailures?: number; mcpServerName?: string; mcpTools?: string[] } = {},
) {
  const closeHandlers = new Set<(client: CodexAppServerClient) => void>();
  const fixture = createComputerUseRequest({
    installed: true,
    probeThreadPrefix: "health-probe-thread",
    ...options,
  });
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (
      [
        "thread/start",
        "mcpServer/tool/call",
        "config/mcpServer/reload",
        "thread/unsubscribe",
      ].includes(method)
    ) {
      return fixture(method, params);
    }
    throw new Error(`unexpected request ${method}`);
  });
  const client = {
    request,
    addCloseHandler(handler: (client: CodexAppServerClient) => void) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
  } as unknown as CodexAppServerClient;
  return {
    client,
    request,
    close: () => {
      for (const handler of closeHandlers) {
        handler(client);
      }
    },
  };
}

function startMonitor(
  client: ReturnType<typeof createClient>,
  overrides: Partial<ResolvedCodexComputerUseConfig> = {},
  tools?: readonly string[],
) {
  return startCodexComputerUseHealthMonitor({
    client: client.client,
    tools,
    config: {
      enabled: true,
      autoInstall: true,
      marketplaceDiscoveryTimeoutMs: 60_000,
      liveTestTimeoutMs: 60_000,
      toolCallTimeoutMs: 60_000,
      healthCheckEnabled: true,
      healthCheckIntervalMinutes: 30,
      pluginCacheMode: "shared",
      strictReadiness: false,
      autoRepair: false,
      pluginName: "computer-use",
      mcpServerName: "computer-use",
      ...overrides,
    },
  });
}

function expectToolCalls(client: ReturnType<typeof createClient>, count: number) {
  expect(
    client.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call"),
  ).toHaveLength(count);
}

function expectProbe(
  client: ReturnType<typeof createClient>,
  server: string,
  tool: string,
  args: Record<string, string>,
  timeoutMs: number,
) {
  expect(client.request).toHaveBeenCalledWith(
    "mcpServer/tool/call",
    { threadId: "health-probe-thread-1", server, tool, arguments: args },
    { timeoutMs },
  );
}
