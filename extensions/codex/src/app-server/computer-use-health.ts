import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { defineCodexBuildState } from "../build-state.js";
import type { CodexAppServerClient } from "./client.js";
import { createComputerUseRequest, runCodexComputerUseLiveTest } from "./computer-use-readiness.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";

type ComputerUseHealthMonitor = {
  fingerprint: string;
  timer: ReturnType<typeof setInterval>;
  disposeCloseHandler: () => void;
  running: boolean;
};

type ComputerUseHealthMonitorState = {
  monitors: WeakMap<CodexAppServerClient, ComputerUseHealthMonitor>;
};

const getComputerUseHealthMonitorState = defineCodexBuildState(
  "openclaw.codexComputerUseHealthMonitorState",
  (): ComputerUseHealthMonitorState => ({ monitors: new WeakMap() }),
);

export function startCodexComputerUseHealthMonitor(params: {
  client: CodexAppServerClient;
  config: ResolvedCodexComputerUseConfig;
  tools?: readonly string[];
}): { started: boolean; intervalMs?: number; reason?: string } {
  const state = getComputerUseHealthMonitorState();
  const existing = state.monitors.get(params.client);
  if (!params.config.enabled || !params.config.healthCheckEnabled) {
    clearComputerUseHealthMonitor(params.client, existing);
    return {
      started: false,
      reason: params.config.enabled ? "health_disabled" : "disabled",
    };
  }
  const fingerprint = JSON.stringify({
    autoRepair: params.config.autoRepair,
    healthCheckIntervalMinutes: params.config.healthCheckIntervalMinutes,
    liveTestTimeoutMs: params.config.liveTestTimeoutMs,
    mcpServerName: params.config.mcpServerName,
    toolCallTimeoutMs: params.config.toolCallTimeoutMs,
    tools: params.tools?.toSorted(),
  });
  const intervalMs = params.config.healthCheckIntervalMinutes * 60_000;
  if (existing?.fingerprint === fingerprint) {
    return { started: false, intervalMs, reason: "already_started" };
  }
  clearComputerUseHealthMonitor(params.client, existing);
  const monitor: ComputerUseHealthMonitor = {
    fingerprint,
    timer: setInterval(() => {
      void runCodexComputerUseHealthProbe(params.client, params.config, monitor, params.tools);
    }, intervalMs),
    disposeCloseHandler: () => undefined,
    running: false,
  };
  monitor.timer.unref?.();
  monitor.disposeCloseHandler = params.client.addCloseHandler((client) => {
    clearComputerUseHealthMonitor(client, state.monitors.get(client));
  });
  state.monitors.set(params.client, monitor);
  return { started: true, intervalMs };
}

async function runCodexComputerUseHealthProbe(
  client: CodexAppServerClient,
  config: ResolvedCodexComputerUseConfig,
  monitor: ComputerUseHealthMonitor,
  tools?: readonly string[],
): Promise<void> {
  if (monitor.running) {
    return;
  }
  monitor.running = true;
  try {
    const { liveTest, repair } = await runCodexComputerUseLiveTest({
      client,
      config,
      tools,
      request: createComputerUseRequest({ client, timeoutMs: config.liveTestTimeoutMs }),
    });
    if (!liveTest.ok) {
      embeddedAgentLog.warn("codex computer-use periodic health failed", {
        mcpServerName: config.mcpServerName,
        attempts: liveTest.attempts,
        timeoutMs: liveTest.timeoutMs,
        error: liveTest.error,
        repair,
      });
      return;
    }
    if (repair?.attempted && repair.warnings.length === 0) {
      embeddedAgentLog.info("codex computer-use periodic health reloaded MCP servers", {
        mcpServerName: config.mcpServerName,
      });
    }
  } catch (error) {
    embeddedAgentLog.warn("codex computer-use periodic health probe crashed", {
      mcpServerName: config.mcpServerName,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    monitor.running = false;
  }
}

function clearComputerUseHealthMonitor(
  client: CodexAppServerClient,
  monitor: ComputerUseHealthMonitor | undefined,
): void {
  if (!monitor) {
    return;
  }
  clearInterval(monitor.timer);
  monitor.disposeCloseHandler();
  getComputerUseHealthMonitorState().monitors.delete(client);
}
