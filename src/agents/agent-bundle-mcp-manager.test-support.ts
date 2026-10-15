import { onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager as createManager } from "./agent-bundle-mcp-manager.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntimeManager as RuntimeManager } from "./agent-bundle-mcp-types.js";

type RuntimeParams = Parameters<typeof acquireSessionMcpRuntime>[0];

export const unopenedMcpConfig = {
  plugins: { enabled: false },
  mcp: { servers: { fixture: { command: process.execPath } } },
} satisfies OpenClawConfig;

// Module-local, so shared (non-isolated) workers reset it with each test file's graph.
let currentGraphManager: unknown;

export async function bindSessionMcpRuntimeTestScheduler(): Promise<void> {
  // The manager lives on globalThis and lazily loads the runtime from the graph
  // that created it. A manager left by an earlier file would bypass this file's
  // mocks and spies, so retire it before binding.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
  if (existing !== undefined && existing !== currentGraphManager) {
    await disposeAllSessionMcpRuntimes();
    Reflect.deleteProperty(globalStore, SESSION_MCP_RUNTIME_MANAGER_KEY);
  }
  const scheduler = createTestGatewayScheduler();
  onTestFinished(() => scheduler.stop());
  await setSessionMcpRuntimeScheduler(scheduler);
  currentGraphManager = globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
}

export function makeRequesterParams(
  sessionId: string,
  cfg: RuntimeParams["cfg"],
  requesterSenderId: string,
  overrides: Partial<RuntimeParams> = {},
): RuntimeParams {
  return {
    sessionId,
    workspaceDir: "/workspace",
    cfg,
    requesterSenderId,
    messageChannel: "telegram",
    ...overrides,
  };
}

// Passive cache/TTL tests deliberately relinquish admission before inspecting the
// raw runtime. Production callers transfer the acquired lease to their consumer.
export async function getOrCreateSessionMcpRuntime(
  params: Parameters<typeof acquireSessionMcpRuntime>[0],
) {
  const lease = await acquireSessionMcpRuntime(params);
  lease.releaseLease();
  return lease.runtime;
}

export function createSessionMcpRuntimeManager({
  scheduler = createTestGatewayScheduler(),
  ...opts
}: Partial<Parameters<typeof createManager>[0]> = {}) {
  const manager = createManager({ ...opts, scheduler });
  return Object.assign(manager, {
    async getOrCreate(params: Parameters<RuntimeManager["acquire"]>[0]) {
      const lease = await manager.acquire(params);
      lease.releaseLease();
      return lease.runtime;
    },
    async getOrCreateRequesterScoped(
      params: Parameters<RuntimeManager["acquireRequesterScoped"]>[0],
    ) {
      const lease = await manager.acquireRequesterScoped(params);
      lease?.releaseLease();
      return lease;
    },
  });
}

export type SessionMcpRuntimeManager = ReturnType<typeof createSessionMcpRuntimeManager>;
