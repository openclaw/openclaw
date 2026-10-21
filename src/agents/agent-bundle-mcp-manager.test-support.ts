import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  bindFixtureIdentity,
  fixtureCatalog,
  fixtureRuntime,
} from "./agent-bundle-mcp-fixture.test-support.js";
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

// Graph-local ownership prevents a previous non-isolated file from bypassing mocks.
let currentGraphManager: unknown;

export async function bindSessionMcpRuntimeTestScheduler(): Promise<void> {
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
export async function getOrCreateSessionMcpRuntime(params: RuntimeParams) {
  const lease = await acquireSessionMcpRuntime(params);
  lease.releaseLease();
  return lease.runtime;
}

export function createSessionMcpRuntimeManager({
  scheduler = createTestGatewayScheduler(),
  createRuntime,
}: Partial<Parameters<typeof createManager>[0]> & {
  createRuntime?: CreateSessionMcpRuntime;
} = {}) {
  const createLifecycle = managerLifecycle.createSessionMcpRuntimeManagerLifecycle;
  let store: ManagerStore | undefined;
  const lifecycleSpy = vi
    .spyOn(managerLifecycle, "createSessionMcpRuntimeManagerLifecycle")
    .mockImplementation((options, defaultCreateRuntime) => {
      const lifecycle = createLifecycle(options, createRuntime ?? defaultCreateRuntime);
      store = lifecycle.store;
      return lifecycle;
    });
  let manager: ReturnType<typeof createManager>;
  try {
    manager = createManager({ scheduler });
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
  return fixtureRuntime(
    () =>
      fixtureCatalog(
        serverName,
        tools.map((tool) => ({
          ...tool,
          inputSchema: {
            type: "object",
            properties: { toolName: { type: "string", const: tool.toolName } },
          },
        })),
      ),
    {
      sessionId: "session-colliding-tools",
      workspaceDir: "/tmp",
      configFingerprint: "fingerprint",
      joinCleanup: async () => {},
    },
  );
}

export function makeManagedRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0],
  tools = [{ toolName: "probe", description: "probe" }],
  serverName?: string,
): SessionMcpRuntime {
  return bindFixtureIdentity(makeRuntime(tools, serverName), params);
}

export type SessionMcpRuntimeManager = ReturnType<typeof createSessionMcpRuntimeManager>;
