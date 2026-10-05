import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
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

export class XAllowlistChangedError extends Error {
  constructor() {
    super("X allowlist changed during authorization; retrying with current policy");
    this.name = "XAllowlistChangedError";
  }
}

// Only mutation lifetimes live here; SQLite remains the owner of allowlist entries.
const mutations = resolveGlobalMap<
  string,
  { generation: object; pending: number; allowFrom?: readonly string[] }
>(Symbol.for("openclaw.x.allowlist-mutations"), "close-and-restart");

export function readPublishedXAllowlist(
  runtime: {
    state: Pick<PluginRuntime["state"], "resolveStateDir">;
  },
  accountId: string,
): readonly string[] {
  const state = mutations.get(JSON.stringify([runtime.state.resolveStateDir(), accountId]));
  return state && !state.pending ? (state.allowFrom ?? []) : [];
}

export function openXAllowlist(runtime: {
  state: Pick<PluginRuntime["state"], "openKeyedStore" | "resolveStateDir">;
}) {
  const stateDir = runtime.state.resolveStateDir();
  const store = runtime.state.openKeyedStore<XAllowlistEntry>({
    namespace: "x.allowlist",
    maxEntries: 10_000,
    overflowPolicy: "reject-new",
  });
  const accountPrefix = (accountId: string) => `${encodeURIComponent(accountId)}:`;
  const mutationState = (accountId: string) => {
    const key = JSON.stringify([stateDir, accountId]);
    let state = mutations.get(key);
    if (!state) {
      state = { generation: {}, pending: 0 };
      mutations.set(key, state);
    }
    return { key, state };
  };
  const mutate = async <T>(
    accountId: string,
    assertCurrent: (() => void) | undefined,
    write: () => Promise<T>,
  ) => {
    assertCurrent?.();
    const { state } = mutationState(accountId);
    state.generation = {};
    state.allowFrom = undefined;
    state.pending++;
    try {
      return await write();
    } finally {
      state.pending--;
      state.generation = {};
    }
  };
  const list = async (accountId: string): Promise<XAllowlistEntry[]> => {
    const prefix = accountPrefix(accountId);
    return (await store.entries())
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => entry.value)
      .toSorted((a, b) => a.userId.localeCompare(b.userId));
  };
  return {
    list,
    async readSnapshot(accountId: string) {
      const { key, state } = mutationState(accountId);
      const generation = state.generation;
      const assertCurrent = () => {
        if (mutations.get(key) !== state || state.pending || state.generation !== generation) {
          throw new XAllowlistChangedError();
        }
      };
      assertCurrent();
      const allowFrom = (await list(accountId)).map((entry) => entry.userId);
      assertCurrent();
      state.allowFrom = allowFrom;
      return { allowFrom, assertCurrent };
    },
    async put(accountId: string, entry: XAllowlistEntry, assertCurrent?: () => void) {
      await mutate(accountId, assertCurrent, () =>
        store.register(`${accountPrefix(accountId)}${entry.userId}`, entry, { assertCurrent }),
      );
    },
    async remove(accountId: string, userId: string, assertCurrent?: () => void) {
      return await mutate(accountId, assertCurrent, () =>
        store.delete(`${accountPrefix(accountId)}${userId}`, { assertCurrent }),
      );
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
