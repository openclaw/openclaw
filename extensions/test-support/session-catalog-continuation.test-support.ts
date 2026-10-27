import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";

type SessionRuntime = OpenClawPluginApi["runtime"]["agent"]["session"];

export function createSessionCatalogContinuationStore(pluginOwnerId: string, sessionId: string) {
  const entries: ReturnType<NonNullable<SessionRuntime["listSessionEntries"]>> = [];
  const createSessionEntry = vi.fn(
    async (params: Parameters<SessionRuntime["createSessionEntry"]>[0]) => {
      const sessionKey = `agent:${params.agentId ?? "main"}:${params.key}`;
      const entry = {
        sessionId,
        updatedAt: Date.now(),
        pluginOwnerId,
        initializationPending: true as const,
        ...(params.label ? { label: params.label } : {}),
        ...(params.displayName ? { displayName: params.displayName } : {}),
        ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
        pluginExtensions: params.initialEntry.pluginExtensions,
      };
      entries.push({ sessionKey, entry });
      const created = {
        key: sessionKey,
        agentId: params.agentId ?? "main",
        sessionId: entry.sessionId,
        entry,
      };
      try {
        const finalPatch = await params.afterCreate?.(created);
        entry.pluginExtensions = finalPatch?.pluginExtensions ?? entry.pluginExtensions;
        delete (entry as { initializationPending?: true }).initializationPending;
        return created;
      } catch (error) {
        entries.splice(
          entries.findIndex((candidate) => candidate.entry === entry),
          1,
        );
        throw error;
      }
    },
  );
  return { createSessionEntry, entries };
}
