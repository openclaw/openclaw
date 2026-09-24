import { createHash } from "node:crypto";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { z } from "zod";

export const CODEX_MANAGED_THREAD_NAMESPACE = "app-server-managed-threads";
export const CODEX_MANAGED_THREAD_MAX_ENTRIES = 20_000;

const managedThreadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("managed-thread"),
  sourceHomeId: z.string().min(1),
  threadId: z.string().min(1),
  rolloutPath: z.string().min(1).optional(),
});

export type StoredCodexManagedThread = z.infer<typeof managedThreadSchema>;

export type CodexManagedThreadStore = {
  has(sourceHomeId: string, threadId: string): Promise<boolean>;
  mark(params: { sourceHomeId: string; threadId: string; rolloutPath?: string }): Promise<boolean>;
  snapshot(): Promise<ReadonlyMap<string, ReadonlySet<string>>>;
};

export async function markStartedCodexManagedThread(
  store: CodexManagedThreadStore | undefined,
  params: { sourceHomeId: string; rolloutPath?: string; threadId: string },
): Promise<void> {
  if (!store) {
    return;
  }
  try {
    await store.mark({
      sourceHomeId: params.sourceHomeId,
      threadId: params.threadId,
      ...(params.rolloutPath ? { rolloutPath: params.rolloutPath } : {}),
    });
  } catch (error) {
    // Keep this boundary fail-open even for a custom or legacy store implementation.
    // A catalog duplicate is less harmful than rejecting an otherwise valid new session.
    embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
  }
}

function managedThreadStoreKey(sourceHomeId: string, threadId: string): string {
  return `sha256:${createHash("sha256")
    .update("openclaw:codex-managed-thread:v1\0")
    .update(sourceHomeId)
    .update("\0")
    .update(threadId)
    .digest("hex")}`;
}

/** Durable ownership index for Codex threads created by OpenClaw. */
export function createCodexManagedThreadStore(
  state: Pick<PluginStateKeyedStore<StoredCodexManagedThread>, "entries" | "registerIfAbsent">,
): CodexManagedThreadStore {
  type Membership = Pick<StoredCodexManagedThread, "sourceHomeId" | "threadId">;
  const byHome = new Map<string, Set<string>>();
  const memberships = new Map<string, Membership>();
  let hydration: Promise<void> | undefined;
  const remember = ({ sourceHomeId, threadId }: Membership) => {
    const key = managedThreadStoreKey(sourceHomeId, threadId);
    if (memberships.has(key)) {
      return key;
    }
    memberships.set(key, { sourceHomeId, threadId });
    let ids = byHome.get(sourceHomeId);
    if (!ids) {
      ids = new Set();
      byHome.set(sourceHomeId, ids);
    }
    ids.add(threadId);
    if (memberships.size > CODEX_MANAGED_THREAD_MAX_ENTRIES) {
      const oldest = memberships.entries().next().value;
      if (oldest) {
        memberships.delete(oldest[0]);
        const oldestHome = byHome.get(oldest[1].sourceHomeId);
        oldestHome?.delete(oldest[1].threadId);
        if (oldestHome?.size === 0) {
          byHome.delete(oldest[1].sourceHomeId);
        }
      }
    }
    return key;
  };
  const snapshot = async () => {
    hydration ??= state
      .entries()
      .then((entries) => {
        const marked = new Map(memberships);
        memberships.clear();
        byHome.clear();
        for (const entry of entries.toSorted((a, b) => a.createdAt - b.createdAt)) {
          const parsed = managedThreadSchema.safeParse(entry.value);
          if (parsed.success) {
            marked.delete(remember(parsed.data));
          }
        }
        // Marks absent from the loaded snapshot arrived during hydration. Append
        // those only; marking an existing key must not refresh its eviction age.
        for (const membership of marked.values()) {
          remember(membership);
        }
      })
      .catch((error: unknown) => {
        hydration = undefined;
        throw error;
      });
    await hydration;
    return byHome;
  };
  return {
    async has(sourceHomeId, threadId) {
      return (await snapshot()).get(sourceHomeId)?.has(threadId) ?? false;
    },
    async mark(params) {
      try {
        const value = managedThreadSchema.parse({
          version: 1,
          kind: "managed-thread",
          sourceHomeId: params.sourceHomeId.trim(),
          threadId: params.threadId.trim(),
          ...(params.rolloutPath?.trim() ? { rolloutPath: params.rolloutPath.trim() } : {}),
        });
        await state.registerIfAbsent(
          managedThreadStoreKey(value.sourceHomeId, value.threadId),
          value,
        );
        remember(value);
        return true;
      } catch (error) {
        // Catalog ownership is advisory bookkeeping. Losing an old catalog exclusion is safer
        // than aborting a real Codex session start when plugin state is full or unavailable.
        embeddedAgentLog.warn("failed to record Codex managed thread ownership", { error });
        return false;
      }
    },
    snapshot,
  };
}
