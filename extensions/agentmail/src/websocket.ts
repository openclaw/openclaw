import type { AgentMail } from "agentmail";
import { createAgentMailClient } from "./client.js";
import type { AgentMailIngressRecord, ResolvedAgentMailAccount } from "./types.js";

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
  return Math.min(1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 5), 30_000);
}

async function waitForRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) {
    return false;
  }
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function receiveUntilDurable(params: {
  record: AgentMailIngressRecord;
  receive: (record: AgentMailIngressRecord) => Promise<void>;
  abortSignal: AbortSignal;
  retryDelay: (attempt: number) => number;
  log?: WebSocketLog;
}): Promise<void> {
  let attempts = 0;
  while (!params.abortSignal.aborted) {
    try {
      await params.receive(params.record);
      return;
    } catch (error) {
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
}): Promise<void> {
  const client = createAgentMailClient(params.account);
  const socket = await client.websockets.connect({
    apiKey: params.account.apiKey,
    abortSignal: params.abortSignal,
    // The pinned SDK bounds exponential delay at 10 seconds. Infinity keeps recovery alive across
    // long outages instead of silently exhausting the SDK's default 30-attempt budget.
    reconnectAttempts: Number.POSITIVE_INFINITY,
  });
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
  };
  socket.on("open", subscribe);
  socket.on("close", () => {
    subscribedForCurrentConnection = false;
  });
  socket.on("message", (event) => {
    if (!isReceivedEvent(event)) {
      return;
    }
    if (event.message.inboxId !== params.account.inboxId) {
      params.log?.warn?.("AgentMail WebSocket ignored an event for the wrong inbox");
      return;
    }
    void receiveUntilDurable({
      record: {
        accountId: params.account.accountId,
        inboxId: event.message.inboxId,
        messageId: event.message.messageId,
        eventId: event.eventId,
        transport: "websocket",
        receivedAt: Date.now(),
      },
      receive: params.receive,
      abortSignal: params.abortSignal,
      retryDelay: params.retryDelayMs ?? websocketRetryDelayMs,
      log: params.log,
    });
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
}
