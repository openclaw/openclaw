import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireSessionMcpRuntime } from "./agent-bundle-mcp-manager-api.js";
import { createSessionMcpRuntimeManager as createManager } from "./agent-bundle-mcp-manager.js";
import type { SessionMcpRuntimeManager as RuntimeManager } from "./agent-bundle-mcp-types.js";

type RuntimeParams = Parameters<typeof acquireSessionMcpRuntime>[0];

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

export const unopenedMcpConfig = {
  plugins: { enabled: false },
  mcp: { servers: { fixture: { command: process.execPath } } },
} satisfies OpenClawConfig;

// Passive cache/TTL tests deliberately relinquish admission before inspecting the
// raw runtime. Production callers transfer the acquired lease to their consumer.
export async function getOrCreateSessionMcpRuntime(
  params: Parameters<typeof acquireSessionMcpRuntime>[0],
) {
  const lease = await acquireSessionMcpRuntime(params);
  lease.releaseLease();
  return lease.runtime;
}

export function createSessionMcpRuntimeManager(...args: Parameters<typeof createManager>) {
  const manager = createManager(...args);
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
