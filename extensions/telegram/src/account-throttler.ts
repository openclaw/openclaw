import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiError } from "grammy/types";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import {
  createSubsystemLogger,
  logVerbose,
  sleepWithAbort,
  waitForAbortSignal,
} from "openclaw/plugin-sdk/runtime-env";
import { apiThrottler } from "./bot.runtime.js";
import { TELEGRAM_CHAT_ACTION_INTERVAL_MS } from "./chat-action-timing.js";
import { isTelegramRateLimitError, readTelegramRetryAfterMs } from "./network-errors.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";

type ApiThrottlerTransformer = ReturnType<typeof apiThrottler>;
type TelegramApiCall = Parameters<ApiThrottlerTransformer>[0];
type TelegramApiSignal = Parameters<ApiThrottlerTransformer>[3];

// Telegram's 429 retry_after is a bot-token penalty. This limiter is its only
// owner: every call for the token waits for the deadline, non-replaceable calls
// (final replies, deletes, reactions) retry within this budget, and replaceable
// calls (stream previews, typing) yield instead of queueing behind the penalty.
const TELEGRAM_OUTBOUND_FLOOD_BUDGET_MS = 5 * 60_000;
// Telegram 429s carry retry_after; a bare 429 gets one short fixed pause, with
// no state carried into later responses.
const FLOOD_PAUSE_WITHOUT_RETRY_AFTER_MS = 1_000;
const floodLog = createSubsystemLogger("telegram/flood");
type TelegramRequestScope = { replaceable?: true; assertCurrent?: () => void };
const requestScopes = new AsyncLocalStorage<TelegramRequestScope>();

/** Runs Telegram calls whose content the next update supersedes, such as stream previews. */
export function runReplaceableTelegramRequest<T>(run: () => Promise<T>): Promise<T> {
  return requestScopes.run({ ...requestScopes.getStore(), replaceable: true }, run);
}

/**
 * Runs Telegram calls whose caller checked send authority before entering the
 * API. A flood wait happens inside that call, so the limiter re-runs the check
 * after every wait and before the next attempt reaches Telegram.
 */
export function runAuthorizedTelegramRequest<T>(
  assertCurrent: (() => void) | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!assertCurrent) {
    return run();
  }
  const outer = requestScopes.getStore();
  const outerAssert = outer?.assertCurrent;
  return requestScopes.run(
    {
      ...outer,
      assertCurrent: outerAssert
        ? () => {
            outerAssert();
            assertCurrent();
          }
        : assertCurrent,
    },
    run,
  );
}

// Synthetic 429s for requests the limiter held back; they never reached Telegram.
const unsentFloodResponses = new WeakSet<object>();

function skippedFloodResponse(waitMs: number, reason: string): ApiError {
  const retryAfter = Math.max(1, Math.ceil(waitMs / 1000));
  const response: ApiError = {
    ok: false,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter} (${reason}; request not sent)`,
    parameters: { retry_after: retryAfter },
  };
  unsentFloodResponses.add(response);
  return response;
}

/**
 * The single enforcement point, run where a request leaves for Telegram after
 * every scheduler and throttler queue wait: a closed gate holds the request back
 * and the caller's send authority is checked against the current writer.
 */
function admitAtNetwork(
  gate: TelegramFloodGate,
  scope: TelegramRequestScope | undefined,
  prev: TelegramApiCall,
): TelegramApiCall {
  return async (method, payload, signal) => {
    const waitMs = method === "getUpdates" ? 0 : gate.remainingMs();
    if (waitMs > 0) {
      return skippedFloodResponse(waitMs, "flood wait active");
    }
    scope?.assertCurrent?.();
    return prev(method, payload, signal);
  };
}

class TelegramFloodGate {
  #untilMs = 0;

  remainingMs(): number {
    return Math.max(0, this.#untilMs - Date.now());
  }

  close(retryAfterSeconds: number | undefined): number {
    const waitMs =
      retryAfterSeconds !== undefined && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : FLOOD_PAUSE_WITHOUT_RETRY_AFTER_MS;
    // Keep the later deadline: a shorter concurrent 429 never shortens an active pause.
    this.#untilMs = Math.max(this.#untilMs, Date.now() + waitMs);
    return this.remainingMs();
  }
}

async function sleepForFloodGate(waitMs: number, signal: TelegramApiSignal): Promise<void> {
  // grammY may supply the legacy node-fetch signal; bridge only its abort event.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  try {
    await sleepWithAbort(waitMs, controller.signal);
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function callThroughFloodGate(
  gate: TelegramFloodGate,
  scope: TelegramRequestScope | undefined,
  prev: TelegramApiCall,
): TelegramApiCall {
  const replaceable = scope?.replaceable === true;
  return async (method, payload, signal) => {
    // The ingress worker owns getUpdates flood waits (and long polls must not stall here).
    if (method === "getUpdates") {
      return prev(method, payload, signal);
    }
    let waitedMs = 0;
    let flooded: ApiError | undefined;
    for (;;) {
      const waitMs = gate.remainingMs();
      if (waitMs > 0) {
        if (replaceable) {
          return flooded ?? skippedFloodResponse(waitMs, "flood wait active");
        }
        if (waitedMs + waitMs > TELEGRAM_OUTBOUND_FLOOD_BUDGET_MS) {
          return flooded ?? skippedFloodResponse(waitMs, "flood wait exceeds delivery budget");
        }
        await sleepForFloodGate(waitMs, signal);
        waitedMs += waitMs;
        continue;
      }
      const closeGate = (retryAfterSeconds: number | undefined) => {
        const closedMs = gate.close(retryAfterSeconds);
        floodLog.warn(
          `Telegram flood control on ${method}: all calls for this bot wait ${Math.ceil(closedMs / 1000)}s` +
            (replaceable ? "; replaceable update skipped" : ""),
        );
      };
      let result: Awaited<ReturnType<TelegramApiCall>>;
      try {
        result = await prev(method, payload, signal);
      } catch (error) {
        // The chat-action handler throws Bot API failures after its own backoff
        // bookkeeping; a thrown 429 still penalizes the whole token.
        if (isTelegramRateLimitError(error)) {
          const retryAfterMs = readTelegramRetryAfterMs(error);
          closeGate(retryAfterMs === undefined ? undefined : retryAfterMs / 1000);
        }
        throw error;
      }
      if (result.ok || result.error_code !== 429) {
        return result;
      }
      flooded = result;
      // A request held back at the network point already waits on the current deadline.
      if (!unsentFloodResponses.has(result)) {
        closeGate(result.parameters?.retry_after);
      }
      if (replaceable) {
        return result;
      }
    }
  };
}
type TelegramAccountThrottler = {
  transformer: ApiThrottlerTransformer;
  chatActions: ReturnType<typeof createTelegramSendChatActionHandler>;
};
type TelegramApiPayload = {
  chat_id?: unknown;
  direct_messages_topic_id?: unknown;
  message_id?: unknown;
  message_thread_id?: unknown;
};
type QueuedApiRequest<T> = {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
};

class GroupRequestScheduler {
  private readonly lanes = new Map<string, Array<QueuedApiRequest<unknown>>>();
  private laneOrder: string[] = [];
  private nextLaneIndex = 0;
  private pendingPriority = 0;
  private running = false;
  private actionTail = Promise.resolve();
  private nextActionAtMs = 0;

  enqueueAction<T>(
    run: () => Promise<T>,
    signal: Parameters<ApiThrottlerTransformer>[3],
  ): Promise<T> {
    // grammY may supply the legacy node-fetch signal; bridge only its abort event.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener("abort", abort, { once: true });
    }
    const result = this.actionTail.then(async () => {
      controller.signal.throwIfAborted();
      const waitMs = this.nextActionAtMs - Date.now();
      if (waitMs > 0) {
        await sleepWithAbort(waitMs, controller.signal);
      }
      try {
        return await run();
      } finally {
        // The final API guard can back off after this queue's wait.
        this.nextActionAtMs = Date.now() + 1_000;
      }
    });
    this.actionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return Promise.race([
      result,
      waitForAbortSignal(controller.signal).then(() => {
        throw new DOMException("Chat action canceled", "AbortError");
      }),
    ]).finally(() => {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    });
  }

  /** Holds priority for a reply until it settles, including its flood waits. */
  async withPriority<T>(run: () => Promise<T>): Promise<T> {
    this.pendingPriority += 1;
    try {
      return await run();
    } finally {
      this.pendingPriority -= 1;
    }
  }

  enqueue<T>(
    laneKey: string,
    run: () => Promise<T>,
    replaceable: { skip: () => T } | undefined,
  ): Promise<T> {
    // Replaceable updates never queue behind pending replies; the next update carries their content.
    if (replaceable && this.pendingPriority > 0) {
      return Promise.resolve(replaceable.skip());
    }
    return new Promise<T>((resolve, reject) => {
      const request: QueuedApiRequest<unknown> = {
        run: replaceable
          ? async () => (this.pendingPriority > 0 ? replaceable.skip() : await run())
          : run,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const existing = this.lanes.get(laneKey);
      if (existing) {
        existing.push(request);
      } else {
        this.lanes.set(laneKey, [request]);
        this.laneOrder.push(laneKey);
      }
      this.start();
    });
  }

  private start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (true) {
        const request = this.takeNext();
        if (!request) {
          return;
        }
        try {
          request.resolve(await request.run());
        } catch (err) {
          request.reject(err);
        }
      }
    } finally {
      this.running = false;
      if (this.laneOrder.length > 0) {
        this.start();
      }
    }
  }

  private takeNext(): QueuedApiRequest<unknown> | undefined {
    for (let remaining = this.laneOrder.length; remaining > 0; remaining -= 1) {
      this.nextLaneIndex %= this.laneOrder.length;
      const laneKey = expectDefined(
        this.laneOrder[this.nextLaneIndex],
        "non-empty Telegram throttle lane order",
      );
      const queue = this.lanes.get(laneKey);
      if (!queue || queue.length === 0) {
        this.lanes.delete(laneKey);
        this.laneOrder.splice(this.nextLaneIndex, 1);
        if (this.laneOrder.length === 0) {
          this.nextLaneIndex = 0;
          return undefined;
        }
        continue;
      }

      const request = queue.shift();
      this.nextLaneIndex += 1;
      return request;
    }
    return undefined;
  }
}

const TELEGRAM_ACCOUNT_THROTTLERS_KEY = Symbol.for("openclaw.telegram.accountThrottlers");

function readPayload(payload: unknown): TelegramApiPayload | undefined {
  return payload && typeof payload === "object" ? (payload as TelegramApiPayload) : undefined;
}

function resolveGroupChatKey(payload: TelegramApiPayload): string | undefined {
  const chatId = parseStrictInteger(payload.chat_id);
  return chatId !== undefined && chatId < 0 ? String(chatId) : undefined;
}

function resolveForumLaneKey(payload: TelegramApiPayload): string {
  const threadId = parseStrictInteger(payload.message_thread_id);
  if (threadId !== undefined) {
    return `topic:${threadId}`;
  }
  const directTopicId = parseStrictInteger(payload.direct_messages_topic_id);
  if (directTopicId !== undefined) {
    return `direct-topic:${directTopicId}`;
  }
  const messageId = parseStrictInteger(payload.message_id);
  if (messageId !== undefined) {
    return `message:${messageId}`;
  }
  return "main";
}

function createTelegramAccountThrottler(
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): TelegramAccountThrottler {
  const baseThrottler = createThrottler();
  const chatActions = createTelegramSendChatActionHandler({
    logger: (message) => logVerbose(`telegram: ${message}`),
    minIntervalMs: TELEGRAM_CHAT_ACTION_INTERVAL_MS,
  });
  const schedulersByChat = new Map<string, GroupRequestScheduler>();
  const floodGate = new TelegramFloodGate();
  const getScheduler = (groupChatKey: string) => {
    let scheduler = schedulersByChat.get(groupChatKey);
    if (!scheduler) {
      scheduler = new GroupRequestScheduler();
      schedulersByChat.set(groupChatKey, scheduler);
    }
    return scheduler;
  };

  const scheduleRequest: (replaceable: boolean) => ApiThrottlerTransformer =
    (replaceable) => (prev, method, payload, signal) => {
      const apiPayload = readPayload(payload);
      const groupChatKey = apiPayload ? resolveGroupChatKey(apiPayload) : undefined;
      if (!apiPayload || !groupChatKey) {
        return baseThrottler(
          (queuedMethod, queuedPayload, queuedSignal) =>
            chatActions.apiTransformer(prev, queuedMethod, queuedPayload, queuedSignal),
          method,
          payload,
          signal,
        );
      }

      const scheduler = getScheduler(groupChatKey);
      if (method === "sendChatAction") {
        // Ephemeral actions must not spend message reservoirs; the shared guard honors flood waits.
        return scheduler.enqueueAction(
          () => chatActions.apiTransformer(prev, method, payload, signal),
          signal,
        );
      }

      const laneKey = resolveForumLaneKey(apiPayload);
      return scheduler.enqueue(
        laneKey,
        () => baseThrottler(prev, method, payload, signal),
        replaceable
          ? { skip: () => skippedFloodResponse(1_000, "yielded to a pending reply") }
          : undefined,
      );
    };

  const transformer: ApiThrottlerTransformer = (prev, method, payload, signal) => {
    // Classify at the call site: queued work later runs in the drain's async context.
    const callerScope = requestScopes.getStore();
    const replaceable = method === "sendChatAction" || callerScope?.replaceable === true;
    const scope = replaceable ? { ...callerScope, replaceable: true as const } : callerScope;
    // Waiting and retry policy runs outside the queues; admission runs at the network edge.
    const admitted = admitAtNetwork(floodGate, scope, prev);
    const send = callThroughFloodGate(
      floodGate,
      scope,
      (queuedMethod, queuedPayload, queuedSignal) =>
        scheduleRequest(replaceable)(admitted, queuedMethod, queuedPayload, queuedSignal),
    );
    const apiPayload = readPayload(payload);
    const groupChatKey = apiPayload ? resolveGroupChatKey(apiPayload) : undefined;
    return replaceable || !groupChatKey
      ? send(method, payload, signal)
      : getScheduler(groupChatKey).withPriority(() => send(method, payload, signal));
  };
  return { transformer, chatActions };
}

export function getOrCreateAccountThrottler(
  token: string,
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): TelegramAccountThrottler {
  const throttlerByToken = resolveGlobalMap<string, TelegramAccountThrottler>(
    TELEGRAM_ACCOUNT_THROTTLERS_KEY,
  );
  let throttler = throttlerByToken.get(token);
  if (!throttler) {
    throttler = createTelegramAccountThrottler(createThrottler);
    throttlerByToken.set(token, throttler);
  }
  return throttler;
}
