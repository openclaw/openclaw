import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { isFeishuMessageFeedbackStale } from "./message-feedback-age.js";
import { addReactionFeishu, removeReactionFeishu } from "./reactions.js";
import { isFeishuBackoffError } from "./typing-backoff.js";

type Reaction = {
  phase: "idle" | "adding" | "active" | "uncertain" | "removed";
  reactionId?: string;
  deleteAttempts: number;
};

export type FeishuProcessingTarget = {
  messageCreateTimeMs?: number;
  messageId: string;
  chatId: string;
  topicId?: string;
  routeKey: string;
};

type Receipt = Omit<FeishuProcessingTarget, "messageCreateTimeMs"> & {
  accountId: string;
  appId: string;
  wait: Reaction;
  typing: Reaction;
};

export type FeishuProcessingMessage = {
  queued: () => void;
  included: (run: { runId: string; completion: Promise<void> }) => void;
  abandoned: () => void;
  settled: () => void;
};

type Source = {
  messageCreateTimeMs?: number;
  key: string;
  sequence: number;
  receipt: Receipt;
  loaded: boolean;
  durable: boolean;
  replay: boolean;
  queued: boolean;
  terminal: boolean;
  runId?: string;
  handle: FeishuProcessingMessage;
};

const idleReaction = (): Reaction => ({ phase: "idle", deleteAttempts: 0 });
const MAX_SOURCES = 10_000;
const BACKOFF_MS = 60_000;
const inactiveMessage: FeishuProcessingMessage = {
  queued() {},
  included() {},
  abandoned() {},
  settled() {},
};
const RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

/** One account owns exact provider receipts; model output never chooses these targets. */
export function createFeishuProcessingIndicator(options: {
  cfg: ClawdbotConfig;
  accountId: string;
  appId: string;
  state: Pick<PluginRuntime["state"], "openKeyedStore">;
  trackTask?: (task: Promise<void>) => void;
  onError?: (error: unknown) => void;
  assertCurrent?: () => void;
  addReaction?: typeof addReactionFeishu;
  removeReaction?: typeof removeReactionFeishu;
}) {
  const add = options.addReaction ?? addReactionFeishu;
  const remove = options.removeReaction ?? removeReactionFeishu;
  const sources = new Map<string, Source>();
  const routes = new Map<string, { task: Promise<void>; dirty: boolean }>();
  let stopped = false;
  let backoffUntil = 0;
  const isBackedOff = () => Date.now() < backoffUntil;
  let sequence = 0;
  const openStore = () =>
    options.state.openKeyedStore<Receipt>({
      namespace: "feishu.processing-indicator",
      maxEntries: MAX_SOURCES,
      overflowPolicy: "reject-new",
    });
  let store: ReturnType<typeof openStore>;
  const report = (error: unknown) => {
    let reportedError = error;
    if (isFeishuBackoffError(error)) {
      backoffUntil = Date.now() + BACKOFF_MS;
      reportedError = new Error(
        `Feishu processing feedback paused for 60 seconds after rate-limit or quota error: ${String(error)}`,
      );
    }
    try {
      options.onError?.(reportedError);
    } catch {
      // Diagnostics cannot break inbound processing or receipt cleanup.
    }
  };
  const save = async (source: Source) => {
    const canExpire = [source.receipt.wait, source.receipt.typing].every(
      (reaction) => reaction.phase === "idle" || reaction.phase === "removed",
    );
    source.durable = false;
    await store.register(
      source.key,
      structuredClone(source.receipt),
      canExpire ? { ttlMs: RECEIPT_TTL_MS } : undefined,
    );
    source.durable = true;
  };

  const removeExact = async (source: Source, kind: "wait" | "typing") => {
    const reaction = source.receipt[kind];
    if (!reaction.reactionId) {
      return reaction.phase === "idle" || reaction.phase === "removed";
    }
    if (reaction.phase === "removed") {
      return true;
    }
    // Retry exact failed receipts on account restart, never in a tight provider loop.
    if (reaction.deleteAttempts > 0 || isBackedOff()) {
      return false;
    }
    reaction.deleteAttempts += 1;
    try {
      await save(source);
    } catch (error) {
      // Retain the exact receipt in memory even if its storage write failed.
      report(error);
    }
    try {
      options.assertCurrent?.();
      await remove({
        cfg: options.cfg,
        accountId: source.receipt.accountId,
        messageId: source.receipt.messageId,
        reactionId: reaction.reactionId,
      });
      reaction.phase = "removed";
      await save(source).catch(report);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  };

  const load = async (source: Source) => {
    if (source.loaded) {
      return;
    }
    const existing = await store.lookup(source.key);
    if (existing) {
      if (
        existing.accountId !== source.receipt.accountId ||
        existing.appId !== source.receipt.appId ||
        existing.chatId !== source.receipt.chatId ||
        (existing.topicId ?? "") !== (source.receipt.topicId ?? "") ||
        existing.messageId !== source.receipt.messageId ||
        existing.routeKey !== source.receipt.routeKey
      ) {
        throw new Error("Feishu processing receipt identity does not match its source");
      }
      source.receipt = existing;
      source.replay = true;
      source.terminal = true;
    } else if (
      !(await store.registerIfAbsent(source.key, source.receipt, { ttlMs: RECEIPT_TTL_MS }))
    ) {
      source.replay = true;
      source.terminal = true;
      const claimed = await store.lookup(source.key);
      if (
        !claimed ||
        claimed.accountId !== source.receipt.accountId ||
        claimed.appId !== source.receipt.appId ||
        claimed.chatId !== source.receipt.chatId ||
        (claimed.topicId ?? "") !== (source.receipt.topicId ?? "") ||
        claimed.messageId !== source.receipt.messageId ||
        claimed.routeKey !== source.receipt.routeKey
      ) {
        throw new Error("Feishu processing claimed receipt identity does not match its source");
      }
      source.receipt = claimed;
    }
    source.loaded = true;
    source.durable = true;
  };

  const create = async (source: Source, kind: "wait" | "typing", current: () => boolean) => {
    // New receipt intent may arrive while another source's storage operation awaits.
    await load(source);
    const currentAndFresh = () =>
      current() && !isFeishuMessageFeedbackStale(source.messageCreateTimeMs);
    const reaction = source.receipt[kind];
    if (
      reaction.phase !== "idle" ||
      source.replay ||
      stopped ||
      isBackedOff() ||
      !currentAndFresh()
    ) {
      return reaction.phase === "active";
    }
    reaction.phase = "adding";
    try {
      // Persist an attempt before the write. A lost add return can never authorize a re-add.
      await save(source);
    } catch (error) {
      reaction.phase = "uncertain";
      report(error);
      return false;
    }
    if (stopped || isBackedOff() || !currentAndFresh()) {
      reaction.phase = "removed";
      await save(source).catch(report);
      return false;
    }
    try {
      options.assertCurrent?.();
      const { reactionId } = await add({
        cfg: options.cfg,
        accountId: source.receipt.accountId,
        messageId: source.receipt.messageId,
        emojiType: kind === "wait" ? "OneSecond" : "Typing",
      });
      if (!reactionId.trim()) {
        throw new Error("Feishu processing reaction returned no exact receipt");
      }
      reaction.reactionId = reactionId;
      reaction.phase = "active";
      try {
        await save(source);
      } catch (error) {
        report(error);
        await removeExact(source, kind);
        return false;
      }
      if (stopped || !current()) {
        await removeExact(source, kind);
        return false;
      }
      return true;
    } catch (error) {
      reaction.phase = "uncertain";
      report(error);
      await save(source).catch(report);
      return false;
    }
  };

  const latest = (routeKey: string, kind: "wait" | "typing") => {
    let found: Source | undefined;
    for (const source of sources.values()) {
      if (
        source.receipt.routeKey === routeKey &&
        !source.terminal &&
        (kind === "wait" ? source.queued && !source.runId : Boolean(source.runId)) &&
        (!found || source.sequence > found.sequence)
      ) {
        found = source;
      }
    }
    return found;
  };

  const reconcile = async (routeKey: string) => {
    const local = [...sources.values()].filter((source) => source.receipt.routeKey === routeKey);
    for (const source of local) {
      if (!source.loaded && !source.queued && !source.runId) {
        if (source.terminal) {
          sources.delete(source.key);
        }
        continue;
      }
      try {
        await load(source);
      } catch (error) {
        report(error);
        source.terminal = true;
        sources.delete(source.key);
      }
    }
    const wait = latest(routeKey, "wait");
    if (wait) {
      await create(wait, "wait", () => latest(routeKey, "wait") === wait);
    }
    for (const source of local) {
      const currentWait = latest(routeKey, "wait");
      if (
        source.terminal ||
        source.runId ||
        (source !== currentWait && currentWait?.receipt.wait.phase === "active")
      ) {
        await removeExact(source, "wait");
      }
    }
    const typing = latest(routeKey, "typing");
    if (typing && (await removeExact(typing, "wait"))) {
      await create(typing, "typing", () => latest(routeKey, "typing") === typing);
    }
    const currentTyping = latest(routeKey, "typing");
    for (const source of local) {
      if (
        source.terminal ||
        (source !== currentTyping && currentTyping?.receipt.typing.phase === "active")
      ) {
        await removeExact(source, "typing");
      }
      if (
        source.terminal &&
        (source.durable ||
          [source.receipt.wait, source.receipt.typing].every(
            (reaction) => !reaction.reactionId || reaction.phase === "removed",
          ))
      ) {
        // Stored exact failures belong to restart recovery; only unsaved receipts need RAM.
        sources.delete(source.key);
      }
    }
  };

  // Recovery only removes stored, exact receipts. In-flight/uncertain creates stay closed.
  const ready = Promise.resolve()
    .then(async () => {
      store = openStore();
      for (const { key, value } of await store.entries()) {
        if (value.accountId !== options.accountId || value.appId !== options.appId) {
          continue;
        }
        if (
          key !==
          JSON.stringify([
            value.accountId,
            value.appId,
            value.chatId,
            value.topicId ?? "",
            value.messageId,
          ])
        ) {
          report(new Error("Feishu processing recovery receipt identity is invalid"));
          continue;
        }
        value.wait.deleteAttempts = 0;
        value.typing.deleteAttempts = 0;
        const source: Source = {
          key,
          sequence: 0,
          receipt: value,
          loaded: true,
          durable: true,
          replay: true,
          queued: false,
          terminal: true,
          handle: inactiveMessage,
        };
        await removeExact(source, "wait");
        await removeExact(source, "typing");
      }
    })
    .catch(report);
  const track = (task: Promise<void>) => {
    try {
      options.trackTask?.(task);
    } catch (error) {
      report(error);
    }
  };
  track(ready.catch(() => undefined));

  const schedule = (routeKey: string) => {
    const pending = routes.get(routeKey);
    if (pending) {
      pending.dirty = true;
      return;
    }
    const route = { task: Promise.resolve(), dirty: true };
    route.task = ready.then(async () => {
      try {
        while (route.dirty) {
          route.dirty = false;
          await reconcile(routeKey);
        }
      } catch (error) {
        report(error);
      } finally {
        routes.delete(routeKey);
      }
    });
    routes.set(routeKey, route);
    track(route.task);
  };

  return {
    receive(target: FeishuProcessingTarget): FeishuProcessingMessage {
      if (stopped) {
        return inactiveMessage;
      }
      if (
        !options.accountId.trim() ||
        !options.appId.trim() ||
        !target.messageId.trim() ||
        !target.chatId.trim() ||
        !target.routeKey.trim()
      ) {
        report(new Error("Feishu processing source identity is incomplete"));
        return inactiveMessage;
      }
      const key = JSON.stringify([
        options.accountId,
        options.appId,
        target.chatId,
        target.topicId ?? "",
        target.messageId,
      ]);
      const existing = sources.get(key);
      if (existing) {
        return existing.handle;
      }
      if (sources.size >= MAX_SOURCES) {
        report(
          new Error("Feishu processing receipt capacity reached; feedback disabled for source"),
        );
        return inactiveMessage;
      }
      const finish = () => {
        source.terminal = true;
        source.queued = false;
        schedule(source.receipt.routeKey);
      };
      const finishRun = () => {
        for (const sibling of sources.values()) {
          if (
            sibling.receipt.routeKey === source.receipt.routeKey &&
            (sibling === source || (source.runId && sibling.runId === source.runId))
          ) {
            sibling.terminal = true;
            sibling.queued = false;
          }
        }
        schedule(source.receipt.routeKey);
      };
      const handle: FeishuProcessingMessage = {
        queued: () => {
          if (!stopped && !source.terminal && !source.runId) {
            source.queued = true;
            schedule(source.receipt.routeKey);
          }
        },
        included: ({ runId, completion }) => {
          if (stopped || source.terminal || source.runId) {
            return;
          }
          source.runId = runId;
          source.queued = false;
          schedule(source.receipt.routeKey);
          void completion.then(finishRun, finishRun);
        },
        abandoned: finish,
        settled: finish,
      };
      const source: Source = {
        messageCreateTimeMs: target.messageCreateTimeMs,
        key,
        sequence: ++sequence,
        receipt: {
          messageId: target.messageId,
          chatId: target.chatId,
          // The state store rejects explicit undefined fields; DMs have no topic.
          ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
          routeKey: target.routeKey,
          accountId: options.accountId,
          appId: options.appId,
          wait: idleReaction(),
          typing: idleReaction(),
        },
        loaded: false,
        durable: false,
        replay: false,
        queued: false,
        terminal: false,
        handle,
      };
      sources.set(key, source);
      return source.handle;
    },
    stop() {
      stopped = true;
      for (const source of sources.values()) {
        source.terminal = true;
        source.queued = false;
        schedule(source.receipt.routeKey);
      }
    },
    async drain() {
      await ready.catch(() => undefined);
      while (routes.size > 0) {
        await Promise.all([...routes.values()].map((route) => route.task));
      }
    },
  };
}
