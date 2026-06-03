import { createDurableInboundReceiveJournal } from "openclaw/plugin-sdk/channel-outbound";
import { resolveGlobalDedupeCache } from "openclaw/plugin-sdk/dedupe-runtime";
import { getOptionalSlackRuntime } from "../runtime.js";
import type { SlackMessageEvent } from "../types.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20_000;
const PERSISTENT_MAX_ENTRIES = 20_000;
const PERSISTENT_NAMESPACE = "slack.inbound-deliveries";
const INGRESS_PENDING_NAMESPACE = "slack.inbound-ingress.v1.pending";
const INGRESS_COMPLETED_NAMESPACE = "slack.inbound-ingress.v1.completed";
const INGRESS_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INGRESS_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INGRESS_MAX_ENTRIES = 20_000;
const SLACK_INBOUND_DELIVERIES_KEY = Symbol.for("openclaw.slackInboundDeliveries");

type SlackInboundDeliveryRecord = {
  deliveredAt: number;
};

type SlackInboundDeliveryStore = {
  register(
    key: string,
    value: SlackInboundDeliveryRecord,
    opts?: { ttlMs?: number },
  ): Promise<void>;
  lookup(key: string): Promise<SlackInboundDeliveryRecord | undefined>;
};

type SlackInboundIngressPayload = {
  message: SlackMessageEvent;
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
  };
  receivedAt: number;
};

type SlackInboundIngressMetadata = {
  accountId: string;
  channelId: string;
  ts: string;
  threadTs?: string;
};

type SlackInboundIngressCompletedMetadata = SlackInboundIngressMetadata & {
  outcome: "delivered" | "dropped" | "duplicate-delivered" | "error";
  reason?: string;
};

const deliveredMessages = resolveGlobalDedupeCache(SLACK_INBOUND_DELIVERIES_KEY, {
  ttlMs: TTL_MS,
  maxSize: MAX_ENTRIES,
});

let persistentStore: SlackInboundDeliveryStore | undefined;
let persistentStoreDisabled = false;
let ingressJournal:
  | ReturnType<
      typeof createDurableInboundReceiveJournal<
        SlackInboundIngressPayload,
        SlackInboundIngressMetadata,
        SlackInboundIngressCompletedMetadata
      >
    >
  | undefined;
let ingressJournalDisabled = false;

function makeKey(accountId: string, channelId: string, ts: string): string {
  return `${accountId}:${channelId}:${ts}`;
}

function makeIngressMetadata(params: {
  accountId: string;
  message: SlackMessageEvent;
}): SlackInboundIngressMetadata | null {
  if (!params.accountId || !params.message.channel || !params.message.ts) {
    return null;
  }
  return {
    accountId: params.accountId,
    channelId: params.message.channel,
    ts: params.message.ts,
    ...(params.message.thread_ts ? { threadTs: params.message.thread_ts } : {}),
  };
}

function reportPersistentInboundDeliveryError(error: unknown): void {
  try {
    getOptionalSlackRuntime()
      ?.logging.getChildLogger({ plugin: "slack", feature: "inbound-delivery-state" })
      .warn("Slack persistent inbound delivery state failed", { error: String(error) });
  } catch {
    // Best effort only: persistent state must never break Slack message handling.
  }
}

function disablePersistentInboundDelivery(error: unknown): void {
  persistentStoreDisabled = true;
  persistentStore = undefined;
  reportPersistentInboundDeliveryError(error);
}

function disablePersistentIngressJournal(error: unknown): void {
  ingressJournalDisabled = true;
  ingressJournal = undefined;
  reportPersistentInboundDeliveryError(error);
}

function getPersistentInboundDeliveryStore(): SlackInboundDeliveryStore | undefined {
  if (persistentStoreDisabled) {
    return undefined;
  }
  if (persistentStore) {
    return persistentStore;
  }
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    persistentStore = runtime.state.openKeyedStore<SlackInboundDeliveryRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: TTL_MS,
    });
    return persistentStore;
  } catch (error) {
    disablePersistentInboundDelivery(error);
    return undefined;
  }
}

function getPersistentInboundIngressJournal(): typeof ingressJournal {
  if (ingressJournalDisabled) {
    return undefined;
  }
  if (ingressJournal) {
    return ingressJournal;
  }
  const runtime = getOptionalSlackRuntime();
  if (!runtime) {
    return undefined;
  }
  try {
    ingressJournal = createDurableInboundReceiveJournal<
      SlackInboundIngressPayload,
      SlackInboundIngressMetadata,
      SlackInboundIngressCompletedMetadata
    >({
      pendingStore: runtime.state.openKeyedStore({
        namespace: INGRESS_PENDING_NAMESPACE,
        maxEntries: INGRESS_MAX_ENTRIES,
        defaultTtlMs: INGRESS_PENDING_TTL_MS,
      }),
      completedStore: runtime.state.openKeyedStore({
        namespace: INGRESS_COMPLETED_NAMESPACE,
        maxEntries: INGRESS_MAX_ENTRIES,
        defaultTtlMs: INGRESS_COMPLETED_TTL_MS,
      }),
      pendingTtlMs: INGRESS_PENDING_TTL_MS,
      completedTtlMs: INGRESS_COMPLETED_TTL_MS,
    });
    return ingressJournal;
  } catch (error) {
    disablePersistentIngressJournal(error);
    return undefined;
  }
}

async function lookupPersistentInboundDelivery(key: string): Promise<boolean> {
  const store = getPersistentInboundDeliveryStore();
  if (!store) {
    return false;
  }
  try {
    return Boolean(await store.lookup(key));
  } catch (error) {
    disablePersistentInboundDelivery(error);
    return false;
  }
}

async function rememberPersistentInboundDelivery(key: string, deliveredAt: number): Promise<void> {
  const store = getPersistentInboundDeliveryStore();
  if (!store) {
    return;
  }
  try {
    await store.register(key, { deliveredAt });
  } catch (error) {
    disablePersistentInboundDelivery(error);
  }
}

export async function hasSlackInboundMessageDelivery(params: {
  accountId: string;
  channelId: string | undefined;
  ts: string | undefined;
}): Promise<boolean> {
  if (!params.accountId || !params.channelId || !params.ts) {
    return false;
  }
  const key = makeKey(params.accountId, params.channelId, params.ts);
  if (deliveredMessages.peek(key)) {
    return true;
  }
  const found = await lookupPersistentInboundDelivery(key);
  if (found) {
    deliveredMessages.check(key);
  }
  return found;
}

export async function recordSlackInboundMessageDeliveries(params: {
  accountId: string;
  messages: readonly SlackMessageEvent[];
}): Promise<void> {
  if (!params.accountId || params.messages.length === 0) {
    return;
  }
  const deliveredAt = Date.now();
  const keys = new Set<string>();
  for (const message of params.messages) {
    if (!message.channel || !message.ts) {
      continue;
    }
    keys.add(makeKey(params.accountId, message.channel, message.ts));
  }
  if (keys.size === 0) {
    return;
  }
  for (const key of keys) {
    deliveredMessages.check(key, deliveredAt);
  }
  await Promise.all(Array.from(keys, (key) => rememberPersistentInboundDelivery(key, deliveredAt)));
}

export async function acceptSlackInboundMessageIngress(params: {
  accountId: string;
  message: SlackMessageEvent;
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
  };
}): Promise<{ accepted: boolean; id?: string }> {
  const metadata = makeIngressMetadata(params);
  if (!metadata) {
    return { accepted: false };
  }
  const journal = getPersistentInboundIngressJournal();
  if (!journal) {
    return { accepted: false, id: makeKey(metadata.accountId, metadata.channelId, metadata.ts) };
  }
  const id = makeKey(metadata.accountId, metadata.channelId, metadata.ts);
  try {
    const receivedAt = Date.now();
    const result = await journal.accept(
      id,
      {
        message: params.message,
        opts: params.opts,
        receivedAt,
      },
      {
        metadata,
        receivedAt,
      },
    );
    return { accepted: result.kind === "accepted", id };
  } catch (error) {
    disablePersistentIngressJournal(error);
    return { accepted: false, id };
  }
}

export async function completeSlackInboundMessageIngress(params: {
  accountId: string;
  message: SlackMessageEvent;
  outcome: SlackInboundIngressCompletedMetadata["outcome"];
  reason?: string;
}): Promise<void> {
  const metadata = makeIngressMetadata(params);
  const journal = getPersistentInboundIngressJournal();
  if (!metadata || !journal) {
    return;
  }
  try {
    await journal.complete(makeKey(metadata.accountId, metadata.channelId, metadata.ts), {
      metadata: {
        ...metadata,
        outcome: params.outcome,
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });
  } catch (error) {
    disablePersistentIngressJournal(error);
  }
}

export async function releaseSlackInboundMessageIngress(params: {
  accountId: string;
  message: SlackMessageEvent;
  reason: string;
}): Promise<void> {
  const metadata = makeIngressMetadata(params);
  const journal = getPersistentInboundIngressJournal();
  if (!metadata || !journal) {
    return;
  }
  try {
    await journal.release(makeKey(metadata.accountId, metadata.channelId, metadata.ts), {
      lastError: params.reason,
    });
  } catch (error) {
    disablePersistentIngressJournal(error);
  }
}

export function clearSlackInboundDeliveryStateForTest(): void {
  deliveredMessages.clear();
  persistentStore = undefined;
  persistentStoreDisabled = false;
  ingressJournal = undefined;
  ingressJournalDisabled = false;
}
