import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { z } from "zod";
import { isRetryableError, MattermostPostSchema, type MattermostUser } from "./client.js";
import {
  resolveMattermostMonitorInboundAccess,
  shouldRetainMattermostSenderHistory,
} from "./monitor-auth.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import {
  createChannelHistoryWindow,
  isDangerousNameMatchingEnabled,
  type ChatType,
  type HistoryEntry,
} from "./runtime-api.js";

const TIMEOUT_MS = 5_000;
const COOLDOWN_MS = 60_000;
const MAX_ATTEMPTS = 3;
const MAX_RECOVERIES = 1_000;
const MAX_IN_FLIGHT = 8;
// Mattermost's getPostThread endpoint rejects perPage above 200.
const MAX_THREAD_POSTS = 200;
const ThreadSchema = z.object({
  order: z.array(z.string()),
  posts: z.record(z.string(), MattermostPostSchema),
});

type ThreadTurn = {
  historyKey: string;
  agentId: string;
  channelId: string;
  kind: ChatType;
  threadRootId: string;
  currentPostId: string;
  currentPostTimestamp: number;
};
type BackfillResult = {
  current: boolean;
  /** Transient merge bounded by the server page plus one shared history window. */
  history?: HistoryEntry[];
};
type Recovery = {
  identity: string | null;
  attempts: number;
  nextAttemptAt: number;
  status: "pending" | "seeded" | "settled";
  completion?: Promise<HistoryEntry[] | undefined>;
};

/** Recovery and pending history share one monitor lifetime, never a durable shadow store. */
export function createMattermostThreadBackfill(params: {
  monitor: MattermostMonitorContext;
  channelHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
}) {
  const { monitor, channelHistories, historyLimit } = params;
  const { account, cfg, client } = monitor;
  const histories = createChannelHistoryWindow({ historyMap: channelHistories });
  const recoveries = new Map<string, Recovery>();
  // Keep actual operations, including timed-out authorization, until they settle.
  // Evicting an LRU marker must never free capacity for another unresolved request.
  const inFlight = new Set<Promise<HistoryEntry[]>>();

  const readIdentity = (turn: ThreadTurn): string | null => {
    const entry = getSessionEntry({
      agentId: turn.agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: turn.agentId }),
      sessionKey: turn.historyKey,
      readConsistency: "latest",
    });
    return entry
      ? JSON.stringify([entry.sessionId ?? null, entry.lifecycleRevision ?? null])
      : null;
  };
  const owns = (turn: ThreadTurn, recovery: Recovery): boolean => {
    if (recoveries.get(turn.historyKey) !== recovery) {
      return false;
    }
    try {
      return readIdentity(turn) === recovery.identity;
    } catch {
      // Unreadable storage is not an absent session and cannot authorize a completion.
      return false;
    }
  };
  const touch = (key: string, recovery: Recovery) => {
    recoveries.delete(key);
    recoveries.set(key, recovery);
    for (const [oldKey, old] of recoveries) {
      if (recoveries.size <= MAX_RECOVERIES) {
        break;
      }
      if (!old.completion) {
        recoveries.delete(oldKey);
      }
    }
  };

  const fetchEntries = async (turn: ThreadTurn, signal: AbortSignal): Promise<HistoryEntry[]> => {
    const query = new URLSearchParams({
      perPage: String(Math.min(historyLimit + 1, MAX_THREAD_POSTS)),
      direction: "up",
      fromPost: turn.currentPostId,
      fromCreateAt: String(turn.currentPostTimestamp),
    });
    const raw = await client.request<unknown>(
      `/posts/${encodeURIComponent(turn.threadRootId)}/thread?${query}`,
      { signal, timeoutMs: TIMEOUT_MS },
    );
    signal.throwIfAborted();
    const thread = ThreadSchema.parse(raw);
    const candidates = thread.order.slice(0, MAX_THREAD_POSTS).flatMap((id) => {
      const post = thread.posts[id];
      if (
        !post ||
        post.id !== id ||
        post.id === turn.currentPostId ||
        post.channel_id !== turn.channelId ||
        (post.id !== turn.threadRootId && post.root_id !== turn.threadRootId) ||
        post.type ||
        !post.user_id ||
        typeof post.create_at !== "number" ||
        post.create_at > turn.currentPostTimestamp ||
        (!post.message?.trim() && !post.file_ids?.length)
      ) {
        return [];
      }
      return [post];
    });
    const senderIds = [...new Set(candidates.map((post) => post.user_id!))];
    let users: MattermostUser[] = [];
    if (senderIds.length && isDangerousNameMatchingEnabled(account.config)) {
      // One bounded directory request, not one 30-second request per sender.
      users = await client.request<MattermostUser[]>("/users/ids", {
        method: "POST",
        body: JSON.stringify(senderIds),
        signal,
        timeoutMs: TIMEOUT_MS,
      });
      signal.throwIfAborted();
    }
    const names = new Map(users.map((user) => [user.id, user.username ?? user.id]));
    let storeFailed = false;
    let storeRead: Promise<Array<string | number>> | undefined;
    const readStoreAllowFrom = () =>
      (storeRead ??= monitor.pairing.readAllowFromStore().catch((error: unknown) => {
        storeFailed = true;
        throw error;
      }));
    const allowed = new Map(
      await Promise.all(
        senderIds.map(async (senderId) => {
          try {
            signal.throwIfAborted();
            const access = await resolveMattermostMonitorInboundAccess({
              account,
              cfg,
              senderId,
              senderName: names.get(senderId) ?? senderId,
              channelId: turn.channelId,
              kind: turn.kind,
              groupPolicy: monitor.groupPolicy,
              readStoreAllowFrom,
              allowTextCommands: false,
              hasControlCommand: false,
              mayPair: false,
            });
            signal.throwIfAborted();
            return [
              senderId,
              !storeFailed &&
                shouldRetainMattermostSenderHistory({
                  cfg,
                  accountId: account.accountId,
                  kind: turn.kind,
                  ingress: access.ingress,
                }),
            ] as const;
          } catch {
            return [senderId, false] as const;
          }
        }),
      ),
    );
    signal.throwIfAborted();
    return candidates
      .filter((post) => allowed.get(post.user_id!))
      .toSorted((a, b) => a.create_at! - b.create_at! || a.id.localeCompare(b.id))
      .map((post) => ({
        sender: names.get(post.user_id!) ?? post.user_id!,
        body: post.message?.trim() || "[attachment]",
        timestamp: post.create_at!,
        messageId: post.id,
      }));
  };

  return async (turn: ThreadTurn): Promise<BackfillResult> => {
    if (
      historyLimit <= 0 ||
      !Number.isFinite(turn.currentPostTimestamp) ||
      turn.currentPostTimestamp <= 0
    ) {
      return { current: true };
    }
    let identity: string | null;
    try {
      identity = readIdentity(turn);
    } catch {
      monitor.logVerboseMessage("mattermost: thread recovery skipped (session store unavailable)");
      return { current: true };
    }
    const previous = recoveries.get(turn.historyKey);
    let recovery = previous;
    if (!recovery || recovery.identity !== identity) {
      // Carry spent budgets/cooldowns across materialization, but never adopt an
      // unbound success: creation and reset may both occur before the next call.
      // In-flight absent->present transitions likewise have no binding proof.
      const adopting = previous?.identity === null && identity !== null;
      recovery = {
        identity,
        attempts: adopting ? previous.attempts : 0,
        nextAttemptAt: adopting ? previous.nextAttemptAt : 0,
        status:
          adopting && !previous.completion && previous.attempts > 0 ? previous.status : "pending",
      };
      if (!previous && (channelHistories.get(turn.historyKey)?.length ?? 0) > 0) {
        recovery.status = "seeded";
      }
    }
    touch(turn.historyKey, recovery);
    if (recovery.completion) {
      const history = await recovery.completion;
      return { current: owns(turn, recovery), history };
    }
    if (recovery.status === "settled") {
      return { current: true };
    }
    if (recovery.status === "seeded" && channelHistories.has(turn.historyKey)) {
      return { current: true };
    }
    if (
      recovery.attempts >= MAX_ATTEMPTS ||
      Date.now() < recovery.nextAttemptAt ||
      inFlight.size >= MAX_IN_FLIGHT
    ) {
      return { current: true };
    }

    recovery.attempts++;
    recovery.nextAttemptAt = Date.now() + COOLDOWN_MS;
    const owner = recovery;
    const controller = new AbortController();
    const deadlineAt = performance.now() + TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException("Mattermost thread recovery deadline", "TimeoutError");
        controller.abort(error);
        reject(error);
      }, TIMEOUT_MS);
    });
    const operation = fetchEntries(turn, controller.signal);
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
    owner.completion = (async () => {
      try {
        const entries = await Promise.race([operation, deadline]);
        if (performance.now() >= deadlineAt) {
          throw new DOMException("Mattermost thread recovery deadline", "TimeoutError");
        }
        if (!owns(turn, owner)) {
          return undefined;
        }
        // Read live history only after every await; merge synchronously after the
        // authoritative identity check. Live entries win duplicate provider ids.
        const live = channelHistories.get(turn.historyKey) ?? [];
        const merged = new Map<string | HistoryEntry, HistoryEntry>();
        for (const entry of [...entries, ...live]) {
          merged.set(entry.messageId ?? entry, entry);
        }
        const snapshot = [...merged.values()].toSorted(
          (a, b) => (a.timestamp ?? Infinity) - (b.timestamp ?? Infinity),
        );
        const window = snapshot.slice(-historyLimit);
        if (window.length) {
          // All live entries are in the replacement; no await separates clear/record.
          histories.clear({ historyKey: turn.historyKey, limit: historyLimit });
          for (const entry of window) {
            histories.record({ historyKey: turn.historyKey, limit: historyLimit, entry });
          }
        }
        owner.attempts = 0;
        owner.nextAttemptAt = 0;
        owner.status = window.length ? "seeded" : "settled";
        monitor.logVerboseMessage(
          `mattermost: thread recovery retained ${entries.length} entries historyKey=${turn.historyKey}`,
        );
        // Each waiting turn filters this bounded snapshot before truncating it.
        // Newer live posts must not displace the older trigger's recovered context.
        return snapshot;
      } catch (error) {
        if (!owns(turn, owner)) {
          return undefined;
        }
        owner.status =
          error instanceof Error && isRetryableError(error) && owner.attempts < MAX_ATTEMPTS
            ? "pending"
            : "settled";
        monitor.logVerboseMessage(
          `mattermost: thread recovery ${owner.status === "pending" ? "retry scheduled" : "gave up"} attempt=${owner.attempts}/${MAX_ATTEMPTS}`,
        );
        return undefined;
      } finally {
        clearTimeout(timer!);
        // Only this unique attempt owns its completion; newer records are untouched.
        owner.completion = undefined;
      }
    })();
    const history = await owner.completion;
    return { current: owns(turn, owner), history };
  };
}
