import { vi } from "vitest";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  upsertSessionEntry,
} from "../config/sessions/store.js";

type SessionRows = Record<string, Record<string, unknown>>;

export async function readSubagentSessionRows(agentId: string): Promise<SessionRows> {
  try {
    return Object.fromEntries(
      listSessionEntries({ agentId }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    ) as SessionRows;
  } catch {
    // ignore
  }
  return {};
}

export async function writeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  sessionId?: string;
  updatedAt?: number;
  abortedLastRun?: boolean;
  agentId: string;
  defaultSessionId: string;
}): Promise<string> {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const existing = getSessionEntry({
    agentId: params.agentId,
    env,
    sessionKey: params.sessionKey,
  }) as Record<string, unknown> | undefined;
  upsertSessionEntry({
    agentId: params.agentId,
    env,
    sessionKey: params.sessionKey,
    entry: {
      ...existing,
      sessionId: params.sessionId ?? params.defaultSessionId,
      updatedAt: params.updatedAt ?? Date.now(),
      ...(typeof params.abortedLastRun === "boolean"
        ? { abortedLastRun: params.abortedLastRun }
        : {}),
    },
  });
  return params.agentId;
}

export async function removeSubagentSessionEntry(params: {
  stateDir: string;
  sessionKey: string;
  agentId: string;
}): Promise<string> {
  deleteSessionEntry({
    agentId: params.agentId,
    env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
    sessionKey: params.sessionKey,
  });
  return params.agentId;
}

export function createSubagentRegistryTestDeps(
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
    captureSubagentCompletionReply: vi.fn(async () => undefined),
    ensureContextEnginesInitialized: vi.fn(),
    ensureRuntimePluginsLoaded: vi.fn(),
    getRuntimeConfig: vi.fn(() => ({})),
    resolveAgentTimeoutMs: vi.fn(() => 100),
    resolveContextEngine: vi.fn(async () => ({
      info: { id: "test", name: "Test", version: "0.0.1" },
      ingest: vi.fn(async () => ({ ingested: false })),
      assemble: vi.fn(async ({ messages }) => ({ messages, estimatedTokens: 0 })),
      compact: vi.fn(async () => ({ ok: false, compacted: false })),
    })),
    ...extra,
  };
}
