import { XApiError, parseXPost, type XApiClient, type XPostEnvelope } from "./api.js";
import { resolveXRecipient } from "./recipient.js";

export type XEventStatus = {
  eventMode?: "stream" | "poll";
  streamConnected?: boolean;
  streamBackoffMs?: number;
  lastEventAt?: number;
  cursor?: string;
  message?: string;
};

type XReceiveOptions = {
  api: XApiClient;
  userId: string;
  getCursor: () => Promise<string | undefined>;
  setCursor: (id: string) => Promise<void>;
  onPost: (envelope: XPostEnvelope) => Promise<void>;
  onStatus?: (status: XEventStatus) => void;
  signal: AbortSignal;
};

function laterId(a: string | undefined, b: string): string {
  return !a || BigInt(b) > BigInt(a) ? b : a;
}

export async function pollXMentions(options: XReceiveOptions): Promise<void> {
  const sinceId = await options.getCursor();
  let newestId = sinceId;
  let paginationToken: string | undefined;
  const posts: XPostEnvelope[] = [];
  const seenTokens = new Set<string>();
  do {
    options.signal.throwIfAborted();
    const page = await options.api.getMentions({
      userId: options.userId,
      sinceId,
      paginationToken,
      signal: options.signal,
    });
    posts.push(...page.data.map((post) => ({ post, users: page.includes.users })));
    paginationToken = page.meta.next_token;
    if (paginationToken && seenTokens.has(paginationToken)) {
      throw new Error("X mentions pagination repeated a token");
    }
    if (paginationToken) {
      seenTokens.add(paginationToken);
    }
  } while (paginationToken);
  posts.sort((a, b) =>
    BigInt(a.post.id) < BigInt(b.post.id) ? -1 : BigInt(a.post.id) > BigInt(b.post.id) ? 1 : 0,
  );
  for (const envelope of posts) {
    options.signal.throwIfAborted();
    await options.onPost(envelope);
    newestId = laterId(newestId, envelope.post.id);
    options.onStatus?.({ lastEventAt: Date.now() });
  }
  // A partial page admission must never hide its remaining posts behind since_id.
  if (newestId && newestId !== sinceId) {
    await options.setCursor(newestId);
    options.onStatus?.({ cursor: newestId });
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

function eventEnvelope(value: unknown): XPostEnvelope | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  if (typeof event.event_type === "string" && event.event_type !== "post.mention.create") {
    return undefined;
  }
  const data =
    event.data && typeof event.data === "object"
      ? (event.data as Record<string, unknown>)
      : undefined;
  const post = parseXPost(event.post ?? data?.post ?? event.data);
  return post ? { post, users: [] } : undefined;
}

async function receiveStream(options: XReceiveOptions): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error("X activity stream idle timeout")),
      25_000,
    );
  };
  try {
    armIdleTimer();
    const response = await options.api.openActivityStream(signal);
    if (!response.body) {
      throw new Error("X activity stream has no response body");
    }
    reader = response.body.getReader();
    clearTimeout(idleTimer);
    options.onStatus?.({
      eventMode: "stream",
      streamConnected: true,
      streamBackoffMs: 0,
      message: "activity stream connected",
    });
    await pollXMentions(options);
    const decoder = new TextDecoder();
    let pending = "";
    while (!signal.aborted) {
      armIdleTimer();
      const read = reader.read();
      const cancelOnAbort = () => {
        void reader?.cancel().catch(() => {});
      };
      signal.addEventListener("abort", cancelOnAbort, { once: true });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await read;
      } finally {
        signal.removeEventListener("abort", cancelOnAbort);
        clearTimeout(idleTimer);
      }
      signal.throwIfAborted();
      if (result.done) {
        throw new Error("X activity stream disconnected");
      }
      pending += decoder.decode(result.value, { stream: true });
      if (pending.length > 1_048_576) {
        throw new Error("X activity stream event exceeded 1 MiB");
      }
      let boundary: number;
      while ((boundary = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, boundary).trim();
        pending = pending.slice(boundary + 1);
        if (!line) {
          continue;
        }
        const envelope = eventEnvelope(JSON.parse(line));
        if (!envelope || envelope.post.author_id === options.userId) {
          continue;
        }
        const addressed = await resolveXRecipient({
          api: options.api,
          post: envelope.post,
          users: envelope.users,
          userId: options.userId,
          signal,
        });
        if (!addressed) {
          continue;
        }
        await options.onPost(addressed);
        const cursor = laterId(await options.getCursor(), addressed.post.id);
        await options.setCursor(cursor);
        options.onStatus?.({ cursor, lastEventAt: Date.now() });
      }
    }
  } finally {
    clearTimeout(idleTimer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    options.onStatus?.({ streamConnected: false, message: "activity stream disconnected" });
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
  let backoffMs = 1_000;
  const fallback = () => {
    stream = false;
    options.onStatus?.({
      eventMode: "poll",
      streamConnected: false,
      streamBackoffMs: 0,
      message: "activity API unavailable for this app; polling",
    });
  };
  if (stream) {
    try {
      await options.api.ensureActivitySubscriptions(options.userId, options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (options.mode !== "stream" || (error instanceof XApiError && error.status === 403)) {
        fallback();
      } else {
        throw error;
      }
    }
  }
  try {
    while (!options.signal.aborted) {
      if (!stream) {
        options.onStatus?.({ eventMode: "poll", streamConnected: false });
        try {
          await pollXMentions(options);
        } catch {
          options.signal.throwIfAborted();
          options.onStatus?.({ message: "mentions poll failed; retrying after the poll interval" });
        }
        await wait(Math.max(15, options.pollSeconds ?? 60) * 1000, options.signal);
        continue;
      }
      try {
        await receiveStream(options);
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof XApiError && error.status === 403) {
          fallback();
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
