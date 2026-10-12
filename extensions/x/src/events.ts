import { nextTick } from "node:process";
import { asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  XApiError,
  parseXPostEnvelope,
  type XApiClient,
  type XPage,
  type XPostEnvelope,
} from "./api.js";
import { xActivityCost } from "./pricing.js";
import { resolveXRecipient } from "./recipient.js";
import { XBudgetExceededError, type XSpendStatus } from "./spend.js";

export type XEventStatus = {
  eventMode?: "stream" | "poll";
  streamConnected?: boolean;
  streamBackoffMs?: number;
  lastEventAt?: number;
  cursor?: string;
  message?: string;
  spend?: XSpendStatus;
};

export type XCursorState = {
  sinceId?: string;
  backfill?: { sinceId?: string; paginationToken: string; newestId?: string };
};

type XReceiveOptions = {
  api: XApiClient;
  userId: string;
  getCursor: () => Promise<XCursorState>;
  setCursor: (state: XCursorState) => Promise<void>;
  onPost: (envelope: XPostEnvelope) => Promise<void>;
  onStatus?: (status: XEventStatus) => void;
  onWarning?: (message: string) => void;
  signal: AbortSignal;
};

function laterId(a: string | undefined, b: string): string {
  return !a || BigInt(b) > BigInt(a) ? b : a;
}

async function pollXMentions(options: XReceiveOptions): Promise<void> {
  const cursor = await options.getCursor();
  const sinceId = cursor.sinceId;
  let backfill = cursor.backfill;
  if (backfill && backfill.sinceId !== sinceId) {
    backfill = undefined;
    await options.setCursor({ sinceId });
  }
  let newestId = backfill?.newestId ?? sinceId;
  let paginationToken = backfill?.paginationToken;
  let retriedContinuation = false;
  let continuationInvalid = false;
  let pageError: Error | undefined;
  const posts: XPostEnvelope[] = [];
  const seenTokens = new Set<string>(paginationToken ? [paginationToken] : []);
  for (;;) {
    options.signal.throwIfAborted();
    let page: XPage;
    try {
      page = await options.api.getMentions({
        userId: options.userId,
        sinceId,
        paginationToken,
        signal: options.signal,
      });
    } catch (error) {
      options.signal.throwIfAborted();
      if (
        paginationToken &&
        error instanceof XApiError &&
        error.status === 400 &&
        !retriedContinuation
      ) {
        // X documents expiring pagination tokens without a distinct expiry error.
        // Restart a rejected continuation once; other failures retain its checkpoint.
        await options.setCursor({ sinceId });
        backfill = undefined;
        paginationToken = undefined;
        seenTokens.clear();
        retriedContinuation = true;
        continue;
      }
      pageError =
        error instanceof Error ? error : new Error("X mentions request failed", { cause: error });
      continuationInvalid =
        Boolean(paginationToken) && error instanceof XApiError && error.status === 400;
      break;
    }
    posts.push(...page.data.map((post) => ({ post, users: page.includes.users })));
    paginationToken = page.meta.next_token;
    if (paginationToken && seenTokens.has(paginationToken)) {
      pageError = new Error("X mentions pagination repeated a token");
      continuationInvalid = true;
      break;
    }
    if (paginationToken) {
      seenTokens.add(paginationToken);
    } else {
      break;
    }
  }
  if (continuationInvalid) {
    await options.setCursor({ sinceId });
    paginationToken = undefined;
  }
  posts.sort((a, b) =>
    BigInt(a.post.id) < BigInt(b.post.id) ? -1 : BigInt(a.post.id) > BigInt(b.post.id) ? 1 : 0,
  );
  for (const envelope of posts) {
    options.signal.throwIfAborted();
    await options.onPost(envelope);
    newestId = laterId(newestId, envelope.post.id);
    options.onStatus?.({ lastEventAt: Date.now() });
  }
  if (pageError) {
    if (paginationToken) {
      // Advance the page checkpoint only after every returned mention is durable.
      await options.setCursor({
        sinceId,
        backfill: { sinceId, paginationToken, newestId },
      });
    }
    throw pageError;
  }
  if (backfill || newestId !== sinceId) {
    // Commit the high-water mark and remove its completed continuation together.
    await options.setCursor({ sinceId: newestId });
    if (newestId) {
      options.onStatus?.({ cursor: newestId });
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("X event source aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForXBudgetReset(until: number, signal: AbortSignal): Promise<void> {
  while (Date.now() < until) {
    // A billing-cycle pause can exceed the maximum delay accepted by setTimeout.
    await wait(Math.min(until - Date.now(), 2_147_483_647), signal);
  }
  signal.throwIfAborted();
}

function eventEnvelope(value: unknown): XPostEnvelope | undefined {
  const event = asRecord(asRecord(value).data);
  if (event.event_type !== "post.mention.create") {
    return undefined;
  }
  return parseXPostEnvelope({ post: event.payload, users: asRecord(event.includes).users });
}

async function receiveStream(
  options: XReceiveOptions & { onBudgetPause: (until: number) => void },
  backfillMs: number,
): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let budgetPaused = false;
  let drainRequested = false;
  let closed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let backfill: Promise<void> | undefined;
  let receiver: Promise<void> | undefined;
  let receiveDone = false;
  let receiveError: Error | undefined;
  let wakeReader: (() => void) | undefined;
  let wakeConsumer: (() => void) | undefined;
  const charges = new Set<Promise<void>>();
  const batches: { events: unknown[]; charged: Promise<void> }[] = [];
  const cancelOnAbort = () => {
    void reader?.cancel().catch(() => {});
  };
  const requestDrain = () => {
    drainRequested = true;
    wakeReader?.();
  };
  const pause = (until: number) => {
    budgetPaused = true;
    options.onBudgetPause(until);
    requestDrain();
  };
  const deferFailure = (error: unknown) => {
    receiveError ??=
      error instanceof Error ? error : new Error("X activity stream failed", { cause: error });
    requestDrain();
  };
  const fail = (error: unknown) => {
    deferFailure(error);
    controller.abort(receiveError);
  };
  const checkBudget = async () => {
    const until = await options.api.spend.streamResumeAt();
    if (!closed && until !== undefined) {
      pause(until);
    }
  };
  const unsubscribe = options.api.spend.subscribe(() => {
    void checkBudget().catch((error: unknown) => controller.abort(error));
  });
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error("X activity stream idle timeout")),
      25_000,
    );
  };
  const receiveBatches = async (source: ReadableStreamDefaultReader<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for (;;) {
        options.signal.throwIfAborted();
        const read = source.read();
        let ready = false;
        void read.then(
          () => {
            ready = true;
          },
          () => {
            ready = true;
          },
        );
        if (!drainRequested) {
          armIdleTimer();
          try {
            await new Promise<void>((resolve) => {
              wakeReader = resolve;
              void read.then(
                () => resolve(),
                () => resolve(),
              );
            });
          } finally {
            wakeReader = undefined;
            clearTimeout(idleTimer);
          }
        }
        if (drainRequested && !ready) {
          // Let queued promise jobs in SDK body wrappers expose buffered bytes,
          // without waiting for another network event or discarding their queues.
          await new Promise<void>((resolve) => {
            nextTick(resolve);
          });
          if (!ready) {
            controller.abort();
            options.onStatus?.({ streamConnected: false });
          }
        }
        const result = await read;
        options.signal.throwIfAborted();
        if (result.done) {
          if (drainRequested) {
            return;
          }
          throw new Error("X activity stream disconnected");
        }
        pending += decoder.decode(result.value, { stream: true });
        if (pending.length > 1_048_576) {
          throw new Error("X activity stream event exceeded 1 MiB");
        }
        const events: unknown[] = [];
        let boundary: number;
        while ((boundary = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, boundary).trim();
          pending = pending.slice(boundary + 1);
          if (!line) {
            continue;
          }
          try {
            events.push(JSON.parse(line));
          } catch {
            // Malformed lines join unrecognized envelopes in the diagnostic streak.
            events.push(undefined);
          }
        }
        if (!events.length) {
          continue;
        }
        const cost = events.reduce<number>((total, event) => total + xActivityCost(event), 0);
        const charged = cost ? options.api.spend.charge(cost) : Promise.resolve();
        charges.add(charged);
        void charged.then(
          () => {
            charges.delete(charged);
          },
          (error: unknown) => {
            charges.delete(charged);
            fail(error);
          },
        );
        batches.push({ events, charged });
        wakeConsumer?.();
      }
    } catch (error) {
      if (!(drainRequested && controller.signal.aborted && !options.signal.aborted)) {
        fail(error);
      }
    } finally {
      receiveDone = true;
      wakeConsumer?.();
      clearTimeout(idleTimer);
    }
  };
  try {
    await checkBudget();
    if (budgetPaused) {
      return;
    }
    armIdleTimer();
    const response = await options.api.openActivityStream(signal);
    if (!response.body) {
      throw new Error("X activity stream has no response body");
    }
    reader = response.body.getReader();
    signal.addEventListener("abort", cancelOnAbort, { once: true });
    if (signal.aborted) {
      cancelOnAbort();
    }
    clearTimeout(idleTimer);
    options.onStatus?.({
      eventMode: "stream",
      streamConnected: true,
      streamBackoffMs: 0,
      message: "activity stream connected",
    });
    // Receipt and charging keep running while backfill or recipient checks await.
    receiver = receiveBatches(reader);
    let recipientChecksDeferred = false;
    try {
      await pollXMentions(options);
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof XBudgetExceededError) {
        pause(error.exhaustedUntil);
      } else {
        deferFailure(error);
      }
    }
    backfill = (async () => {
      while (!signal.aborted) {
        if (drainRequested) {
          return;
        }
        await wait(backfillMs, signal);
        if (signal.aborted || drainRequested) {
          return;
        }
        try {
          // Closing the stream stops scheduling, but an already-paid poll must settle.
          await pollXMentions(options);
        } catch (error) {
          options.signal.throwIfAborted();
          if (error instanceof XBudgetExceededError) {
            pause(error.exhaustedUntil);
            return;
          }
          if (!signal.aborted) {
            options.onStatus?.({
              message: "mentions backfill failed; retrying after the backfill interval",
            });
          }
        }
      }
    })().catch((error: unknown) => {
      if (!signal.aborted) {
        fail(error);
      }
    });
    let unparsed = 0;
    for (;;) {
      options.signal.throwIfAborted();
      const batch = batches.shift();
      if (!batch) {
        if (receiveDone) {
          break;
        }
        await new Promise<void>((resolve) => {
          wakeConsumer = resolve;
        });
        wakeConsumer = undefined;
        continue;
      }
      await batch.charged;
      for (const value of batch.events) {
        options.signal.throwIfAborted();
        const envelope = eventEnvelope(value);
        if (!envelope) {
          const event = asRecord(value);
          const type = asRecord(event.data).event_type;
          if (typeof type === "string" && type !== "post.mention.create") {
            continue;
          }
          if (++unparsed === 3) {
            const message = `X activity stream: 3 consecutive events could not be parsed; type=${JSON.stringify(typeof type === "string" ? type.slice(0, 96) : "unknown")} keys=${JSON.stringify(
              Object.keys(event)
                .slice(0, 20)
                .map((key) => key.slice(0, 64)),
            )}`;
            options.onWarning?.(message);
            options.onStatus?.({ message });
          }
          continue;
        }
        if (unparsed >= 3 && !signal.aborted) {
          options.onStatus?.({ message: "activity stream connected" });
        }
        unparsed = 0;
        if (envelope.post.author_id === options.userId) {
          continue;
        }
        let addressed: XPostEnvelope | undefined;
        if (recipientChecksDeferred) {
          addressed = { ...envelope, recipientPending: true };
        } else {
          try {
            addressed = await resolveXRecipient({
              api: options.api,
              post: envelope.post,
              users: envelope.users,
              userId: options.userId,
              signal: options.signal,
            });
          } catch (error) {
            options.signal.throwIfAborted();
            if (!(error instanceof XBudgetExceededError)) {
              recipientChecksDeferred = true;
              deferFailure(error);
            }
            addressed = { ...envelope, recipientPending: true };
          }
        }
        if (!addressed) {
          continue;
        }
        await options.onPost(addressed);
        // Only a completed mentions poll can advance past gaps in stream delivery.
        options.onStatus?.({ lastEventAt: Date.now() });
      }
    }
    if (receiveError) {
      throw receiveError;
    }
  } finally {
    closed = true;
    unsubscribe();
    clearTimeout(idleTimer);
    controller.abort();
    await backfill;
    signal.removeEventListener("abort", cancelOnAbort);
    await reader?.cancel().catch(() => {});
    await receiver;
    await Promise.allSettled(charges);
    reader?.releaseLock();
    options.onStatus?.({
      streamConnected: false,
      ...(budgetPaused ? {} : { message: "activity stream disconnected" }),
    });
  }
}

export async function runXEvents(
  options: XReceiveOptions & {
    mode?: "auto" | "stream" | "poll";
    pollSeconds?: number;
    bearerConfigured: boolean;
  },
): Promise<void> {
  let stream = options.mode !== "poll" && options.bearerConfigured;
  let streamPausedUntil = 0;
  const pauseStream = (until: number) => {
    streamPausedUntil = Math.max(streamPausedUntil, until);
  };
  let backoffMs = 1_000;
  let pollMessage = "mentions polling";
  const fallback = (error: unknown) => {
    stream = false;
    pollMessage = `${error instanceof Error ? error.message : "X Activity API request failed"}; polling`;
    options.onStatus?.({
      eventMode: "poll",
      streamConnected: false,
      streamBackoffMs: 0,
      message: pollMessage,
    });
  };
  if (stream) {
    try {
      await options.api.ensureActivitySubscriptions(options.userId, options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (options.mode !== "stream" || (error instanceof XApiError && error.status === 403)) {
        fallback(error);
      } else {
        throw error;
      }
    }
  }
  try {
    while (!options.signal.aborted) {
      if (stream && Date.now() >= streamPausedUntil) {
        streamPausedUntil = (await options.api.spend.streamResumeAt()) ?? 0;
      }
      if (!stream || Date.now() < streamPausedUntil) {
        options.onStatus?.({
          eventMode: "poll",
          streamConnected: false,
          ...(streamPausedUntil > Date.now()
            ? {
                message: `activity stream paused below $0.50 budget headroom; polling until ${new Date(streamPausedUntil).toISOString()}`,
              }
            : { message: pollMessage }),
        });
        try {
          await pollXMentions(options);
        } catch (error) {
          options.signal.throwIfAborted();
          if (error instanceof XBudgetExceededError) {
            options.onStatus?.({ message: error.message, spend: await options.api.spend.status() });
            await waitForXBudgetReset(error.exhaustedUntil, options.signal);
            continue;
          }
          options.onStatus?.({ message: "mentions poll failed; retrying after the poll interval" });
        }
        const pollWait = Math.max(15, options.pollSeconds ?? 60) * 1000;
        await wait(
          streamPausedUntil > Date.now()
            ? Math.min(pollWait, streamPausedUntil - Date.now())
            : pollWait,
          options.signal,
        );
        continue;
      }
      try {
        await receiveStream(
          { ...options, onBudgetPause: pauseStream },
          Math.max(60, (options.pollSeconds ?? 60) * 4) * 1000,
        );
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof XApiError && (error.status === 401 || error.status === 403)) {
          fallback(error);
          continue;
        }
        options.onStatus?.({
          streamConnected: false,
          streamBackoffMs: backoffMs,
          message: "activity stream reconnect backoff",
        });
        await wait(backoffMs, options.signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  } catch (error) {
    if (!options.signal.aborted) {
      throw error;
    }
  }
}
