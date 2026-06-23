import type { BackendConfig } from "../client/types.js";

/** The async task kinds the completion-notifier can watch. */
export type NotifyKind = "crawl_refresh" | "link_check";

/** Where to deliver a proactive message — captured from the tool context at submit time. */
export interface DeliveryTarget {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

/** A submitted async task we still need to poll and then notify the user about. */
export interface PendingTask {
  id: string; // dedupe key (kind + backendId)
  kind: NotifyKind;
  uid: string; // rabbitmq-<uid> user id, for per-uid api key resolution
  backendId: string; // backend uuid/slug/jobId
  sessionKey: string; // ctx.sessionKey — addresses the user's session for delivery
  mercureTopic: string; // the web-chat Mercure topic to push the result to
  delivery: DeliveryTarget; // redundant copy of the addressing for future explicit routing
  title: string | null;
  createdAt: number;
  attempts: number;
  notified: boolean;
  expiresAt: number;
}

export interface NotifyConfig {
  enabled: boolean;
  pollIntervalMs: number;
  ttlMs: number;
  maxPerTick: number;
}

/** Result of polling one task's backend status. */
export interface PollResult {
  terminal: boolean;
  /** Human-facing one-line/short summary to hand the agent when terminal. */
  summary: string;
}

/** Polls one task kind's backend status. Throws on transport error (caller counts the attempt). */
export type PollAdapter = (
  task: PendingTask,
  apiKey: string,
  config: BackendConfig,
) => Promise<PollResult>;

/** Minimal tool context fields the notifier needs to capture at submit time. */
export interface NotifyToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  deliveryContext?: DeliveryTarget;
}
