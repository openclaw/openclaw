import type { AgentMail, AgentMailClient } from "agentmail";
import { computeBackoff, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import {
  createAgentMailCatchUpSession,
  createAgentMailCatchUpSupervisor,
  type AgentMailCatchUpSession,
} from "./catch-up.js";
import { createAgentMailClient } from "./client.js";
import { AgentMailIngressCapacityError } from "./ingress.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

const AGENTMAIL_WEBSOCKET_LIVE_QUEUE_MAX = 32;
const AGENTMAIL_WEBSOCKET_CATCH_UP_INTERVAL_MS = 60_000;

type WebSocketLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

function isReceivedEvent(value: unknown): value is AgentMail.MessageReceivedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<AgentMail.MessageReceivedEvent>;
  return event.type === "event" && event.eventType === "message.received" && Boolean(event.message);
}

function websocketRetryDelayMs(attempt: number): number {
  return computeBackoff({ initialMs: 1_000, maxMs: 30_000, factor: 2, jitter: 0.2 }, attempt);
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  try {
    await sleepWithAbort(delayMs, signal);
    return !signal.aborted;
  } catch {
    return false;
  }
}

async function receiveUntilDurable(params: {
  record: AgentMailIngressRecord;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  abortSignal: AbortSignal;
  retryDelay: (attempt: number) => number;
  onCapacity: () => void;
  log?: WebSocketLog;
}): Promise<void> {
  let attempts = 0;
  while (!params.abortSignal.aborted) {
    try {
      await params.receive(params.record);
      return;
    } catch (error) {
      if (error instanceof AgentMailIngressCapacityError) {
        // Do not pin the single bounded live worker behind a full durable queue. REST catch-up
        // retains the provider-side source and retries once durable capacity becomes available.
        params.log?.warn?.(
          "AgentMail durable ingress is full; deferring the message to REST catch-up",
        );
        params.onCapacity();
        return;
      }
      attempts += 1;
      params.log?.error?.(
        `AgentMail WebSocket durable ingress failed; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!(await waitForRetry(params.abortSignal, params.retryDelay(attempts)))) {
        return;
      }
    }
  }
}

export async function startAgentMailWebSocket(params: {
  account: ResolvedAgentMailAccount;
  abortSignal: AbortSignal;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  log?: WebSocketLog;
  retryDelayMs?: (attempt: number) => number;
  catchUpSession?: AgentMailCatchUpSession;
  liveQueueMax?: number;
  catchUpIntervalMs?: number;
  client?: AgentMailClient;
}): Promise<void> {
  const client = params.client ?? createAgentMailClient(params.account);
  const catchUpSession =
    params.catchUpSession ??
    (await createAgentMailCatchUpSession({
      account: params.account,
      client,
      log: params.log,
    }));
  const socket = await client.websockets.connect({
    apiKey: params.account.apiKey,
    abortSignal: params.abortSignal,
    // The pinned SDK bounds exponential delay at 10 seconds. Infinity keeps recovery alive across
    // long outages instead of silently exhausting the SDK's default 30-attempt budget.
    reconnectAttempts: Number.POSITIVE_INFINITY,
    // agentmail@0.5.16 waits only for open/error by default; an abort closes the socket and would
    // otherwise leave connect() pending before this function can register its lifecycle handlers.
    waitForOpen: false,
  });
  const retryDelay = params.retryDelayMs ?? websocketRetryDelayMs;
  const liveQueueMax = params.liveQueueMax ?? AGENTMAIL_WEBSOCKET_LIVE_QUEUE_MAX;
  const liveQueue: AgentMailIngressRecord[] = [];
  const queuedMessageIds = new Set<string>();
  let liveWorker: Promise<void> | undefined;
  const catchUpSupervisor = createAgentMailCatchUpSupervisor({
    session: catchUpSession,
    receive: params.receive,
    abortSignal: params.abortSignal,
    retryDelayMs: retryDelay,
    log: params.log,
  });
  const catchUpIntervalMs = params.catchUpIntervalMs ?? AGENTMAIL_WEBSOCKET_CATCH_UP_INTERVAL_MS;
  const periodicCatchUpWorker = (async () => {
    while (!params.abortSignal.aborted) {
      if (!(await waitForRetry(params.abortSignal, catchUpIntervalMs))) {
        return;
      }
      // The SDK protocol has no replay cursor. Periodic REST overlap also covers half-open
      // sockets that emit neither a close event nor new messages.
      catchUpSupervisor.request();
    }
  })();

  const runLiveWorker = (): void => {
    if (liveWorker) {
      return;
    }
    liveWorker = (async () => {
      while (!params.abortSignal.aborted) {
        const record = liveQueue.shift();
        if (!record) {
          return;
        }
        try {
          await receiveUntilDurable({
            record,
            receive: params.receive,
            abortSignal: params.abortSignal,
            retryDelay,
            onCapacity: () => catchUpSupervisor.request(),
            log: params.log,
          });
        } finally {
          queuedMessageIds.delete(record.messageId);
        }
      }
    })().finally(() => {
      liveWorker = undefined;
      if (liveQueue.length > 0 && !params.abortSignal.aborted) {
        runLiveWorker();
      }
    });
  };

  let subscribedForCurrentConnection = false;
  const subscribe = () => {
    if (subscribedForCurrentConnection) {
      return;
    }
    socket.sendSubscribe({
      type: "subscribe",
      inboxIds: [params.account.inboxId],
      eventTypes: ["message.received"],
    });
    subscribedForCurrentConnection = true;
    params.log?.info?.(`AgentMail WebSocket subscribed for account ${params.account.accountId}`);
    // Subscribe first, then overlap the persisted REST cursor. Live and catch-up events share the
    // same durable id, closing restart/reconnect gaps without creating duplicate turns.
    catchUpSupervisor.request();
  };
  socket.on("open", subscribe);
  socket.on("close", () => {
    subscribedForCurrentConnection = false;
  });
  socket.on("error", (error) => {
    params.log?.error?.(
      `AgentMail WebSocket error for account ${params.account.accountId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    // Parsing and transport errors may not close the socket. Recover authoritative events even
    // when the SDK remains connected and therefore does not trigger the reconnect catch-up path.
    catchUpSupervisor.request();
  });
  socket.on("message", (event) => {
    if (!isReceivedEvent(event)) {
      return;
    }
    if (event.message.inboxId !== params.account.inboxId) {
      params.log?.warn?.("AgentMail WebSocket ignored an event for the wrong inbox");
      return;
    }
    if (queuedMessageIds.has(event.message.messageId)) {
      return;
    }
    if (queuedMessageIds.size >= liveQueueMax) {
      // Keep the process-local backlog bounded. REST catch-up remains the authoritative recovery
      // source for events dropped while durable admission is backpressured.
      params.log?.warn?.("AgentMail WebSocket live admission is full; scheduling REST catch-up");
      catchUpSupervisor.request();
      return;
    }
    queuedMessageIds.add(event.message.messageId);
    liveQueue.push({
      accountId: params.account.accountId,
      inboxId: event.message.inboxId,
      messageId: event.message.messageId,
      eventId: event.eventId,
      transport: "websocket",
      receivedAt: event.message.timestamp.getTime(),
    });
    runLiveWorker();
  });
  // The SDK's waitForOpen() does not settle when an initial connection is aborted. Register the
  // lifecycle listeners immediately and close the already-open race from readyState instead.
  if (socket.readyState === 1) {
    subscribe();
  }
  await new Promise<void>((resolve) => {
    if (params.abortSignal.aborted) {
      socket.close();
      resolve();
      return;
    }
    params.abortSignal.addEventListener(
      "abort",
      () => {
        socket.close();
        resolve();
      },
      { once: true },
    );
  });
  const workers = [liveWorker, periodicCatchUpWorker, catchUpSupervisor.settle()].filter(
    (worker): worker is Promise<void> => worker !== undefined,
  );
  await Promise.allSettled(workers);
}
