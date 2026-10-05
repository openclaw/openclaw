import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

export type XAllowlistEntry = {
  userId: string;
  username: string;
  name: string;
  addedBy: string;
  addedAt: number;
};

export type XEffectiveAllowlistEntry = {
  userId: string;
  username?: string;
  name?: string;
  addedBy?: string;
  addedAt?: number;
  configured: boolean;
  editable: boolean;
};

export function normalizeXUserId(value: string): string | undefined {
  const id = value.trim().replace(/^x:/i, "");
  return /^[0-9]+$/.test(id) ? id : undefined;
}

export function openXAllowlist(runtime: { state: Pick<PluginRuntime["state"], "openKeyedStore"> }) {
  const store = runtime.state.openKeyedStore<XAllowlistEntry>({
    namespace: "x.allowlist",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
  const accountPrefix = (accountId: string) => `${encodeURIComponent(accountId)}:`;
  const list = async (accountId: string): Promise<XAllowlistEntry[]> => {
    const prefix = accountPrefix(accountId);
    return (await store.entries())
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => entry.value)
      .toSorted((a, b) => a.userId.localeCompare(b.userId));
  };
  return {
    list,
    async readAllowFrom(accountId: string): Promise<string[]> {
      return (await list(accountId)).map((entry) => entry.userId);
    },
    async put(accountId: string, entry: XAllowlistEntry, assertCurrent?: () => void) {
      await store.register(`${accountPrefix(accountId)}${entry.userId}`, entry, {
        assertCurrent,
      });
    },
    async remove(accountId: string, userId: string, assertCurrent?: () => void) {
      return await store.delete(`${accountPrefix(accountId)}${userId}`, { assertCurrent });
    },
  };
}

export function mergeXAllowlist(
  configAllowFrom: readonly string[],
  stored: readonly XAllowlistEntry[],
): XEffectiveAllowlistEntry[] {
  const entries = new Map<string, XEffectiveAllowlistEntry>();
  for (const entry of stored) {
    entries.set(entry.userId, { ...entry, configured: false, editable: true });
  }
  for (const value of configAllowFrom) {
    const userId = normalizeXUserId(value);
    if (userId) {
      entries.set(userId, {
        ...entries.get(userId),
        userId,
        configured: true,
        editable: entries.has(userId),
      });
    }
  }
  return [...entries.values()].toSorted((a, b) => a.userId.localeCompare(b.userId));
}
