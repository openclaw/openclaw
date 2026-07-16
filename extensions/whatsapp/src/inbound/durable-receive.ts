// Whatsapp plugin module implements durable receive behavior.
import { createHash } from "node:crypto";
import type { WAMessage } from "baileys";
import {
  createChannelIngressDrain,
  createDurableInboundReceiveJournalFromQueue,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
  type ChannelIngressQueueClaim,
} from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { getWhatsAppRuntime } from "../runtime.js";
import { BufferJSON } from "../session.runtime.js";

const WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 450;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 450;
const WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WhatsAppReadReceiptTarget = {
  remoteJid: string;
  id: string;
  participant?: string;
};

type SerializedWhatsAppDurableInboundMessage = PluginJsonValue;

export type WhatsAppDurableInboundPayload = {
  message: SerializedWhatsAppDurableInboundMessage;
  upsertType?: string;
  receivedAt: number;
};

export type WhatsAppDurableInboundMetadata = {
  readReceipt?: WhatsAppReadReceiptTarget;
};

export type WhatsAppDurableInboundCompletedMetadata = {
  readReceipt?: WhatsAppReadReceiptTarget;
};

function hashNamespacePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createWhatsAppDurableInboundMessageId(params: {
  remoteJid: string;
  id: string;
}): string {
  return createHash("sha256").update(`${params.remoteJid}\n${params.id}`).digest("hex");
}

export function serializeWhatsAppDurableInboundMessage(
  message: WAMessage,
): SerializedWhatsAppDurableInboundMessage {
  return JSON.parse(JSON.stringify(message, BufferJSON.replacer)) as PluginJsonValue;
}

export function deserializeWhatsAppDurableInboundMessage(
  message: SerializedWhatsAppDurableInboundMessage,
): WAMessage {
  return JSON.parse(JSON.stringify(message), BufferJSON.reviver) as WAMessage;
}

export type WhatsAppDurableInboundStores = {
  journal: ReturnType<
    typeof createDurableInboundReceiveJournalFromQueue<
      WhatsAppDurableInboundPayload,
      WhatsAppDurableInboundMetadata,
      WhatsAppDurableInboundCompletedMetadata
    >
  >;
  queue: ChannelIngressQueue<
    WhatsAppDurableInboundPayload,
    WhatsAppDurableInboundMetadata,
    WhatsAppDurableInboundCompletedMetadata
  >;
};

/** Journal for accept-side dedupe + the queue the core drain claims against. */
export function createWhatsAppDurableInboundStores(
  accountId: string,
): WhatsAppDurableInboundStores {
  const accountPart = hashNamespacePart(accountId);
  const runtime = getWhatsAppRuntime();
  const queue = runtime.state.openChannelIngressQueue<
    WhatsAppDurableInboundPayload,
    WhatsAppDurableInboundMetadata,
    WhatsAppDurableInboundCompletedMetadata
  >({
    accountId: accountPart,
    stateDir: runtime.state.resolveStateDir(),
  });
  const journal = createDurableInboundReceiveJournalFromQueue({
    queue,
    retention: {
      pendingTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      completedTtlMs: WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS,
      failedTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      pendingMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      completedMaxEntries: WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
      failedMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    },
  });
  return { journal, queue };
}

export type WhatsAppDurableClaim = ChannelIngressQueueClaim<
  WhatsAppDurableInboundPayload,
  WhatsAppDurableInboundMetadata
>;

/**
 * Core drain over the WhatsApp inbound queue.
 * Completes on dispatch return (full processing), not lifecycle.onAdopted —
 * matches prior finalize-after-flush tombstone timing.
 */
export function createWhatsAppIngressDrain(params: {
  queue: WhatsAppDurableInboundStores["queue"];
  processClaimed: (claim: WhatsAppDurableClaim) => Promise<void>;
  onLog?: (message: string) => void;
  abortSignal?: AbortSignal;
}): ChannelIngressDrain {
  return createChannelIngressDrain({
    queue: params.queue,
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    // No supersede: WhatsApp never had pre-adoption supersede semantics.
    dispatchClaimedEvent: async (event) => {
      try {
        await params.processClaimed(event);
        // Tombstone after full processing returns (not turn adoption).
        return { kind: "completed" as const };
      } catch (error) {
        return { kind: "failed-retryable" as const, error };
      }
    },
  });
}
