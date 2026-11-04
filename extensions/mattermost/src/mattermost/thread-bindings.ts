import { resolveSessionAgentIdStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isPluginOwnedSessionBindingRecord } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import {
  createAccountScopedBindingAdapterV2,
  projectThreadBindingRecord,
  registerSessionBindingAdapterV2,
  resolveThreadBindingFarewellText,
  resolveThreadBindingLifecycle,
  resolveThreadBindingTargetKind,
  unregisterSessionBindingAdapter,
  type AccountScopedConversationBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { getMattermostRuntime } from "../runtime.js";
import { resolveMattermostAccount, resolveMattermostReplyToMode } from "./accounts.js";
import {
  createMattermostDirectChannelWithRetry,
  createMattermostPost,
  MattermostPostSchema,
  type MattermostClient,
} from "./client.js";

const SWEEP_INTERVAL_MS = 60_000;

/** One Mattermost thread (root post id) bound to a session, under its channel id. */
type MattermostThreadBindingRecord = AccountScopedConversationBindingRecord<
  "subagent" | "acp" | "session"
> & {
  parentConversationId: string;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

type BindInput = Parameters<
  NonNullable<ReturnType<typeof createAccountScopedBindingAdapterV2>["bind"]>
>[0];

type LifecycleUpdate = { targetSessionKey: string; idleTimeoutMs?: number; maxAgeMs?: number };

export type MattermostThreadBindingManager = {
  getByConversationId: (conversationId: string) => MattermostThreadBindingRecord | undefined;
  listBindings: () => MattermostThreadBindingRecord[];
  unbind: (
    records: readonly MattermostThreadBindingRecord[],
    options: { reason?: string; farewell: boolean },
  ) => Promise<MattermostThreadBindingRecord[]>;
  updateBySessionKey: (update: LifecycleUpdate) => Promise<MattermostThreadBindingRecord[]>;
  stop: () => void;
};

const STATE_KEY = Symbol.for("openclaw.mattermostThreadBindingsState");

function getState() {
  return resolveGlobalSingleton(STATE_KEY, () => ({
    managersByAccountId: new Map<string, MattermostThreadBindingManager>(),
    bindingsByKey: new Map<string, MattermostThreadBindingRecord>(),
  }));
}

function resolveBindingKey(record: { accountId: string; conversationId: string }): string {
  // Matches projectThreadBindingRecord's default bindingId, so adapter ids round-trip.
  return `${record.accountId}:${record.conversationId}`;
}

export async function createMattermostThreadBindingManager(params: {
  cfg: OpenClawConfig;
  accountId: string;
  botUserId: string;
  client: MattermostClient;
  enableSweeper?: boolean;
  logVerboseMessage?: (message: string) => void;
}): Promise<MattermostThreadBindingManager> {
  const { accountId, client, cfg } = params;
  const log = (message: string) => params.logVerboseMessage?.(message);
  const state = getState();
  state.managersByAccountId.get(accountId)?.stop();

  const store = getMattermostRuntime().state.openKeyedStoreV2<MattermostThreadBindingRecord>({
    namespace: "mattermost.thread-bindings",
    maxEntries: 10_000,
  });
  for (const { key, value } of await store.entries()) {
    if (value.accountId === accountId) {
      state.bindingsByKey.set(key, value);
    }
  }

  const policy = { cfg, channel: "mattermost", accountId };
  const defaults = {
    idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel(policy),
    maxAgeMs: resolveThreadBindingMaxAgeMsForChannel(policy),
  };
  const lifecycleOf = (record: MattermostThreadBindingRecord) =>
    resolveThreadBindingLifecycle({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    });
  const listBindings = () =>
    [...state.bindingsByKey.values()].filter((record) => record.accountId === accountId);
  const isLive = (record: MattermostThreadBindingRecord, now = Date.now()) => {
    const { expiresAt } = lifecycleOf(record);
    return expiresAt === undefined || expiresAt > now;
  };
  const put = async (record: MattermostThreadBindingRecord) => {
    state.bindingsByKey.set(resolveBindingKey(record), record);
    await store.register(resolveBindingKey(record), record);
  };
  // Adapter calls run from core (spawn, unbind, sweeper) outside the plugin's
  // runtime scope, so post through this monitor's client, not the outbound path.
  const postInThread = (record: MattermostThreadBindingRecord, text: string, what: string) =>
    createMattermostPost(client, {
      channelId: record.parentConversationId,
      message: text,
      rootId: record.conversationId,
    }).catch((error: unknown) => {
      log(`mattermost: thread binding ${what} post failed: ${String(error)}`);
    });

  // Mattermost threads grow from a top-level post. The asker's post becomes the
  // thread root unless that thread is already the requester's own conversation.
  const resolveSourceRoot = async (
    input: BindInput,
    requesterThreadId: string | undefined,
  ): Promise<{ rootId: string; channelId: string } | { reason: string }> => {
    const sourceMessageId = normalizeOptionalString(input.sourceMessageId);
    if (requesterThreadId || !sourceMessageId) {
      return { reason: requesterThreadId ? "requester-in-thread" : "no-source-post" };
    }
    if (
      state.bindingsByKey.has(resolveBindingKey({ accountId, conversationId: sourceMessageId }))
    ) {
      return { reason: "source-post-already-bound" };
    }
    const post = MattermostPostSchema.safeParse(
      await client
        .request<unknown>(`/posts/${encodeURIComponent(sourceMessageId)}`)
        .catch(() => null),
    );
    if (
      !post.success ||
      post.data.channel_id !== input.conversation.conversationId ||
      normalizeOptionalString(post.data.root_id) ||
      post.data.delete_at
    ) {
      return { reason: "source-post-not-top-level" };
    }
    return { rootId: post.data.id, channelId: input.conversation.conversationId };
  };

  const bindChild = async (input: BindInput): Promise<MattermostThreadBindingRecord | null> => {
    assertCurrent();
    input.assertCurrent?.();
    const targetSessionKey = input.targetSessionKey.trim();
    const conversationId = input.conversation.conversationId.trim();
    if (!targetSessionKey || !conversationId) {
      return null;
    }
    const parentConversationId = normalizeOptionalString(input.conversation.parentConversationId);
    const requesterTarget = parentConversationId ?? conversationId;
    // Inbound DM targets stay `user:<id>`; everything else is a channel id.
    const directUserId = requesterTarget.startsWith("user:") ? requesterTarget.slice(5) : undefined;
    const account = resolveMattermostAccount({ cfg, accountId });
    if (directUserId && resolveMattermostReplyToMode(account, "direct") === "off") {
      throw new Error(
        "Mattermost direct messages are flat, so a sub-agent thread cannot be opened here. " +
          "Set channels.mattermost.replyToModeByChatType.direct to enable DM threads, or use mode=run.",
      );
    }
    const metadata = input.metadata ?? {};
    const targetKind = await resolveThreadBindingTargetKind({
      cfg,
      targetSessionKey,
      targetKind: input.targetKind,
      metadata,
      agentId: normalizeOptionalString(metadata.agentId),
      channel: "Mattermost",
      assertCurrent: () => {
        assertCurrent();
        input.assertCurrent?.();
      },
    });
    const label = normalizeOptionalString(metadata.label);
    const agentId =
      normalizeOptionalString(metadata.agentId) ??
      (isPluginOwnedSessionBindingRecord({ metadata })
        ? undefined
        : resolveSessionAgentIdStrict({ config: cfg, sessionKey: targetSessionKey }));

    let root = await resolveSourceRoot(input, parentConversationId ? conversationId : undefined);
    assertCurrent();
    input.assertCurrent?.();
    if ("reason" in root) {
      // Never hand the requester's current thread to the worker: open a new root post.
      const title =
        normalizeOptionalString(metadata.threadName) ?? `🤖 ${label ?? agentId ?? "agent"}`;
      const channelId = directUserId
        ? (
            await createMattermostDirectChannelWithRetry(
              client,
              [params.botUserId, directUserId],
              account.config.dmChannelRetry,
            )
          ).id
        : requesterTarget;
      const post = await createMattermostPost(client, { channelId, message: title });
      log(`mattermost: thread binding opened a new root post ${post.id} (reason=${root.reason})`);
      root = { rootId: post.id, channelId };
    }
    const now = Date.now();
    const record: MattermostThreadBindingRecord = {
      accountId,
      conversationId: root.rootId,
      parentConversationId: root.channelId,
      targetKind,
      targetSessionKey,
      agentId,
      label,
      boundBy: normalizeOptionalString(metadata.boundBy) ?? "system",
      boundAt: now,
      lastActivityAt: now,
      metadata,
    };
    await put(record);
    log(
      `mattermost: bound thread ${record.conversationId} channel=${record.parentConversationId} to ${targetSessionKey}`,
    );
    const introText = normalizeOptionalString(metadata.introText);
    if (introText) {
      await postInThread(record, introText, "intro");
    }
    return record;
  };

  const unbind: MattermostThreadBindingManager["unbind"] = async (records, options) => {
    const removed: MattermostThreadBindingRecord[] = [];
    for (const record of records) {
      const key = resolveBindingKey(record);
      // A rebind of the same thread is a new binding; leave it in place.
      if (state.bindingsByKey.get(key)?.boundAt !== record.boundAt) {
        continue;
      }
      state.bindingsByKey.delete(key);
      removed.push(record);
      await store.delete(key);
      log(`mattermost: unbound thread ${record.conversationId} (reason=${options.reason ?? "-"})`);
      if (options.farewell) {
        const farewell = resolveThreadBindingFarewellText({
          reason: options.reason,
          idleTimeoutMs: record.idleTimeoutMs ?? defaults.idleTimeoutMs,
          maxAgeMs: record.maxAgeMs ?? defaults.maxAgeMs,
        });
        await postInThread(record, farewell, "farewell");
      }
    }
    return removed;
  };

  const project = (record: MattermostThreadBindingRecord) =>
    projectThreadBindingRecord(record, {
      conversation: {
        channel: "mattermost",
        conversationId: record.conversationId,
        parentConversationId: record.parentConversationId,
      },
      targetKind: record.targetKind === "subagent" ? "subagent" : "session",
      lifecycle: {
        expiresAt: lifecycleOf(record).expiresAt,
        idleTimeoutMs: record.idleTimeoutMs ?? defaults.idleTimeoutMs,
        maxAgeMs: record.maxAgeMs ?? defaults.maxAgeMs,
      },
      metadata: (lifecycleMetadata) => ({ ...record.metadata, ...lifecycleMetadata }),
    });

  const getByConversationId = (conversationId: string) => {
    const record = state.bindingsByKey.get(
      resolveBindingKey({ accountId, conversationId: conversationId.trim() }),
    );
    // The sweeper removes expired rows and says farewell; routing stops at expiry.
    return record && isLive(record) ? record : undefined;
  };
  const listBySessionKey = (targetSessionKey: string) =>
    listBindings().filter(
      (record) => record.targetSessionKey === targetSessionKey.trim() && isLive(record),
    );
  const touch = async (conversationId: string, at = Date.now()) => {
    const record = getByConversationId(conversationId);
    if (!record) {
      return null;
    }
    const next = { ...record, lastActivityAt: Math.max(record.lastActivityAt, at) };
    await put(next);
    return next;
  };
  const updateBySessionKey = async (update: LifecycleUpdate) => {
    const updated: MattermostThreadBindingRecord[] = [];
    for (const record of listBySessionKey(update.targetSessionKey)) {
      const next = {
        ...record,
        ...(update.idleTimeoutMs !== undefined
          ? { idleTimeoutMs: Math.max(0, Math.floor(update.idleTimeoutMs)) }
          : {}),
        ...(update.maxAgeMs !== undefined
          ? { maxAgeMs: Math.max(0, Math.floor(update.maxAgeMs)) }
          : {}),
        lastActivityAt: Date.now(),
      };
      await put(next);
      updated.push(next);
    }
    return updated;
  };

  let stopped = false;
  const assertCurrent = () => {
    if (stopped || state.managersByAccountId.get(accountId) !== manager) {
      throw new Error("Mattermost thread binding manager is no longer active");
    }
  };
  const sweepTimer =
    params.enableSweeper === false
      ? undefined
      : setInterval(() => {
          const now = Date.now();
          for (const record of listBindings()) {
            if (!isLive(record, now)) {
              void unbind([record], { reason: lifecycleOf(record).reason, farewell: true }).catch(
                (error: unknown) => {
                  log(`mattermost: failed to expire thread binding: ${String(error)}`);
                },
              );
            }
          }
        }, SWEEP_INTERVAL_MS);
  sweepTimer?.unref?.();

  const manager: MattermostThreadBindingManager = {
    getByConversationId,
    listBindings,
    unbind,
    updateBySessionKey,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(sweepTimer);
      unregisterSessionBindingAdapter({
        channel: "mattermost",
        accountId,
        adapter: sessionBindingAdapter,
      });
      if (state.managersByAccountId.get(accountId) === manager) {
        state.managersByAccountId.delete(accountId);
        // Bindings stay persisted; the next manager for this account reloads them.
        for (const record of listBindings()) {
          state.bindingsByKey.delete(resolveBindingKey(record));
        }
      }
    },
  };

  const byRef = (ref: { conversationId: string }) => getByConversationId(ref.conversationId);
  const sessionBindingAdapter = createAccountScopedBindingAdapterV2({
    channel: "mattermost",
    accountId,
    // Only child threads: `thread: true` must never hand over the current conversation.
    capabilities: { placements: ["child"] },
    assertCurrent,
    bind: async (input) => {
      if (input.conversation.channel !== "mattermost" || input.placement !== "child") {
        return null;
      }
      const record = await bindChild(input);
      return record ? project(record) : null;
    },
    project,
    listBySessionKey,
    getByConversation: byRef,
    touchConversation: (conversationId, at) => {
      void touch(conversationId, at).catch((error: unknown) => {
        log(`mattermost: thread binding touch failed for ${conversationId}: ${String(error)}`);
      });
    },
    unbindConversation: async (conversationId, reason) => {
      const record = getByConversationId(conversationId);
      return record ? ((await unbind([record], { reason, farewell: true }))[0] ?? null) : null;
    },
    unbindBySessionKey: (targetSessionKey, reason) =>
      unbind(listBySessionKey(targetSessionKey), { reason, farewell: true }),
    inspectByConversations: (refs) => {
      const records = refs.map(byRef);
      return {
        records,
        assertCurrent: () => {
          assertCurrent();
          if (refs.some((ref, index) => byRef(ref) !== records[index])) {
            throw new Error("Mattermost thread binding changed during selection");
          }
        },
      };
    },
    listBySessionKeyAsync: async (targetSessionKey) => listBySessionKey(targetSessionKey),
    getByConversationAsync: async (ref) => byRef(ref),
    inspectByConversationAsync: async (ref) => byRef(ref),
    touchConversationAsync: touch,
  });

  state.managersByAccountId.set(accountId, manager);
  registerSessionBindingAdapterV2(sessionBindingAdapter);
  return manager;
}

function listManagers(accountId?: string | null): MattermostThreadBindingManager[] {
  const { managersByAccountId } = getState();
  if (!accountId) {
    return [...managersByAccountId.values()];
  }
  const manager = managersByAccountId.get(accountId);
  return manager ? [manager] : [];
}

/** Backs `/session idle` and `/session max-age` for bindings of one session. */
export async function setMattermostThreadBindingLifecycleBySessionKeyAsync(
  update: LifecycleUpdate & { accountId?: string | null },
) {
  const updated = await Promise.all(
    listManagers(update.accountId).map((manager) => manager.updateBySessionKey(update)),
  );
  return updated.flat().map((record) => ({
    boundAt: record.boundAt,
    lastActivityAt: record.lastActivityAt,
    idleTimeoutMs: record.idleTimeoutMs,
    maxAgeMs: record.maxAgeMs,
  }));
}

export async function handleMattermostSubagentEnded(event: {
  targetSessionKey: string;
  targetKind?: "subagent" | "acp";
  accountId?: string;
  reason?: string;
  sendFarewell?: boolean;
}): Promise<void> {
  for (const manager of listManagers(event.accountId)) {
    const records = manager
      .listBindings()
      .filter(
        (record) =>
          record.targetSessionKey === event.targetSessionKey &&
          (!event.targetKind || record.targetKind === event.targetKind),
      );
    await manager.unbind(records, {
      reason: normalizeOptionalString(event.reason) ?? "subagent-ended",
      farewell: event.sendFarewell === true,
    });
  }
}
