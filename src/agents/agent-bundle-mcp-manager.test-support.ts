import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  acquireSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "./agent-bundle-mcp-manager-api.js";
import { peekSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager-cleanup.js";
import * as managerLifecycle from "./agent-bundle-mcp-manager-lifecycle.js";
import { createSessionMcpRuntimeManager as createManager } from "./agent-bundle-mcp-manager.js";
import {
  SESSION_MCP_RUNTIME_MANAGER_KEY,
  type CreateSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime-shared.js";
import type {
  SessionMcpRuntime,
  SessionMcpRuntimeManager as RuntimeManager,
} from "./agent-bundle-mcp-types.js";

type RuntimeParams = Parameters<typeof acquireSessionMcpRuntime>[0];
type ManagerStore = ReturnType<
  typeof managerLifecycle.createSessionMcpRuntimeManagerLifecycle
>["store"];
const managerStores = new WeakMap<RuntimeManager, ManagerStore>();

export function getSessionMcpRuntimeTestManager() {
  return expectDefined(peekSessionMcpRuntimeManager(), "bound session MCP manager");
}

export function getBookkeepingSizes(manager: RuntimeManager) {
  const store = expectDefined(managerStores.get(manager), "fixture-owned MCP manager store");
  return {
    runtimes: store.runtimesBySessionId.size,
    connectionMeta: store.connectionMetaByRuntimeKey.size,
    runtimeWorkChains: store.runtimeWorkChains.size,
    sessionKeys: store.sessionIdBySessionKey.size,
    deferredRetirement: store.deferredRetirementSessionIds.size,
    advertisedScopedCatalogs: store.advertisedScopedCatalogBySessionId.size,
  };
}

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
  const createLifecycle = managerLifecycle.createSessionMcpRuntimeManagerLifecycle;
  let store: ManagerStore | undefined;
  const lifecycleSpy = vi
    .spyOn(managerLifecycle, "createSessionMcpRuntimeManagerLifecycle")
    .mockImplementation((...args) => {
      const lifecycle = createLifecycle(...args);
      store = lifecycle.store;
      return lifecycle;
    });
  let manager: ReturnType<typeof createManager>;
  try {
    manager = createManager({ ...opts, scheduler });
  } finally {
    lifecycleSpy.mockRestore();
  }
  managerStores.set(manager, expectDefined(store, "created MCP manager store"));
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

export function makeRuntime(
  tools: Array<{ toolName: string; description: string }>,
  serverName = "bundleProbe",
): SessionMcpRuntime {
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  return {
    sessionId: "session-colliding-tools",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => null,
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools: tools.map((tool) => ({
        serverName,
        safeServerName: serverName,
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", const: tool.toolName },
          },
        },
        fallbackDescription: tool.description,
      })),
    }),
    callTool: async (_serverName, toolName) => ({
      content: [{ type: "text", text: toolName }],
      isError: false,
    }),
    joinCleanup: async () => {},
    dispose: async () => {},
  };
}

export function makeManagedRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0],
  tools = [{ toolName: "probe", description: "probe" }],
  serverName?: string,
): SessionMcpRuntime {
  return {
    ...makeRuntime(tools, serverName),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint ?? "fingerprint",
    requesterScope: params.requesterScope,
  };
}

export type SessionMcpRuntimeManager = ReturnType<typeof createSessionMcpRuntimeManager>;
