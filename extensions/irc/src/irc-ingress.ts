// IRC plugin module owns raw PRIVMSG durable admission and replay draining.
import { randomUUID } from "node:crypto";
import {
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isChannelTarget } from "./normalize.js";
import { parseIrcLine, parseIrcPrefix } from "./protocol.js";
import { getIrcRuntime } from "./runtime.js";
import type { IrcInboundMessage } from "./types.js";

const IRC_INGRESS_PAYLOAD_VERSION = 1;
const IRC_INGRESS_POLL_INTERVAL_MS = 1_000;
const IRC_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const IRC_INGRESS_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const IRC_INGRESS_TOMBSTONE_MAX_ENTRIES = 1_000;

type IrcIngressPayload = {
  version: 1;
  eventId: string;
  receivedAt: number;
  connectionEpoch: string;
  connectedNick: string;
  rawLine: string;
};

export type IrcIngressLifecycle = {
  abortSignal: AbortSignal;
  onAdopted: () => void | Promise<void>;
  onDeferred: () => void;
  onAdoptionFinalizing: () => void;
  onAbandoned: () => void | Promise<void>;
};

export type IrcIngressDispatchResult =
  | { kind: "completed" }
  | { kind: "deferred" }
  | { kind: "failed-retryable"; error: unknown };

type IrcIngressDispatch = (
  message: IrcInboundMessage,
  lifecycle: IrcIngressLifecycle,
  context: { connectedNick: string; connectionEpoch: string },
) => Promise<IrcIngressDispatchResult | void> | IrcIngressDispatchResult | void;

class IrcIngressPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IrcIngressPayloadError";
  }
}

function inspectRawPrivmsg(rawLine: string): {
  laneKey: string;
  message: Omit<IrcInboundMessage, "messageId" | "timestamp">;
} {
  const line = parseIrcLine(rawLine);
  if (!line || line.command !== "PRIVMSG") {
    throw new IrcIngressPayloadError("IRC ingress row is not a PRIVMSG line.");
  }
  const rawTarget = line.params[0]?.trim() ?? "";
  const text = line.trailing ?? line.params[1] ?? "";
  const prefix = parseIrcPrefix(line.prefix);
  const senderNick = prefix.nick?.trim() ?? "";
  if (!rawTarget || !senderNick || !text.trim()) {
    throw new IrcIngressPayloadError("IRC PRIVMSG line is missing target, sender, or text.");
  }
  const isGroup = isChannelTarget(rawTarget);
  const target = isGroup ? rawTarget : senderNick;
  const lanePeer = normalizeLowercaseStringOrEmpty(target);
  return {
    laneKey: `${isGroup ? "channel" : "direct"}:${lanePeer}`,
    message: {
      target,
      rawTarget,
      senderNick,
      senderUser: prefix.user?.trim() || undefined,
      senderHost: prefix.host?.trim() || undefined,
      text,
      isGroup,
    },
  };
}

function parseClaimedEvent(
  payload: unknown,
  claimedId: string,
): {
  message: IrcInboundMessage;
  connectedNick: string;
  connectionEpoch: string;
} {
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    (payload as Partial<IrcIngressPayload>).version !== IRC_INGRESS_PAYLOAD_VERSION ||
    (payload as Partial<IrcIngressPayload>).eventId !== claimedId ||
    !Number.isSafeInteger((payload as Partial<IrcIngressPayload>).receivedAt) ||
    ((payload as Partial<IrcIngressPayload>).receivedAt ?? 0) <= 0 ||
    typeof (payload as Partial<IrcIngressPayload>).connectionEpoch !== "string" ||
    !(payload as Partial<IrcIngressPayload>).connectionEpoch?.trim() ||
    typeof (payload as Partial<IrcIngressPayload>).connectedNick !== "string" ||
    !(payload as Partial<IrcIngressPayload>).connectedNick?.trim() ||
    typeof (payload as Partial<IrcIngressPayload>).rawLine !== "string"
  ) {
    throw new IrcIngressPayloadError(`IRC ingress row ${claimedId} has invalid metadata.`);
  }
  const validPayload = payload as IrcIngressPayload;
  const inspected = inspectRawPrivmsg(validPayload.rawLine);
  return {
    message: {
      ...inspected.message,
      messageId: claimedId,
      timestamp: validPayload.receivedAt,
    },
    connectedNick: validPayload.connectedNick.trim(),
    connectionEpoch: validPayload.connectionEpoch.trim(),
  };
}

function resolveIrcIngressNonRetryableFailure(error: unknown) {
  return error instanceof IrcIngressPayloadError
    ? { reason: "invalid-event", message: error.message }
    : null;
}

type IrcIngressConnection = {
  connectionEpoch: string;
  accept: (rawLine: string, connectedNick: string) => Promise<void>;
};

export type IrcIngressMonitor = {
  openConnection: (connectionEpoch?: string) => IrcIngressConnection;
  start: () => void;
  pause: () => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

export function createIrcIngressMonitor(options: {
  accountId: string;
  queue?: ChannelIngressQueue<IrcIngressPayload>;
  dispatch: IrcIngressDispatch;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
}): IrcIngressMonitor {
  let queue = options.queue;
  let drain: ChannelIngressDrain | undefined;
  let running = false;
  let stopped = false;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pauseTask: Promise<void> | undefined;
  let lastPrunedAt = 0;
  let admissionTail: Promise<void> = Promise.resolve();
  const shutdown = new AbortController();

  const getQueue = (): ChannelIngressQueue<IrcIngressPayload> => {
    queue ??= getIrcRuntime().state.openChannelIngressQueue<IrcIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const getDrain = (): ChannelIngressDrain => {
    drain ??= createChannelIngressDrain<IrcIngressPayload>({
      queue: getQueue(),
      abortSignal: shutdown.signal,
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
      },
      resolveNonRetryableFailure: resolveIrcIngressNonRetryableFailure,
      onLog: (message) => options.runtime.log?.(`irc ${message}`),
      dispatchClaimedEvent: async (record, lifecycle) => {
        if (!running || shutdown.signal.aborted || lifecycle.abortSignal.aborted) {
          return {
            kind: "failed-retryable",
            error: new Error("IRC ingress stopped before dispatch."),
          };
        }
        const claimed = parseClaimedEvent(record.payload, record.id);
        const result = await options.dispatch(claimed.message, lifecycle, {
          connectedNick: claimed.connectedNick,
          connectionEpoch: claimed.connectionEpoch,
        });
        if (shutdown.signal.aborted && result?.kind !== "deferred") {
          return {
            kind: "failed-retryable",
            error: new Error("IRC ingress stopped during dispatch."),
          };
        }
        return result;
      },
    });
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < IRC_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: IRC_INGRESS_TOMBSTONE_TTL_MS,
      completedMaxEntries: IRC_INGRESS_TOMBSTONE_MAX_ENTRIES,
      failedTtlMs: IRC_INGRESS_TOMBSTONE_TTL_MS,
      failedMaxEntries: IRC_INGRESS_TOMBSTONE_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      for (;;) {
        requested = false;
        await pruneIfDue();
        // stop() can race the async prune; do not lazily create a live drain afterward.
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        await activeDrain.waitForIdle();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`irc ingress drain failed: ${String(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  const pause = (): Promise<void> => {
    running = false;
    requested = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
    const activePump = pumping;
    if (!activePump) {
      return Promise.resolve();
    }
    pauseTask ??= activePump.finally(() => {
      pauseTask = undefined;
    });
    return pauseTask;
  };

  const admitOnce = async (params: {
    eventId: string;
    rawLine: string;
    receivedAt: number;
    connectionEpoch: string;
    connectedNick: string;
  }): Promise<void> => {
    const connectionEpoch = params.connectionEpoch.trim();
    if (!connectionEpoch) {
      throw new Error("IRC ingress connection epoch is required.");
    }
    const connectedNick = params.connectedNick.trim();
    if (!connectedNick) {
      throw new Error("IRC ingress connected nickname is required.");
    }
    let laneKey: string;
    try {
      // Receive-time inspection extracts queue metadata only. The persisted
      // envelope remains the untouched line and normalization waits for claim.
      laneKey = inspectRawPrivmsg(params.rawLine).laneKey;
    } catch (error) {
      if (!(error instanceof IrcIngressPayloadError)) {
        throw error;
      }
      // Persist malformed accepted input too, so claim-side parsing can apply
      // the permanent failure classifier instead of losing it before append.
      laneKey = `invalid:${params.eventId}`;
    }
    let lastError: unknown;
    // IRC cannot nack or replay an accepted line. Retry the durable append before
    // surfacing the storage failure; later reconnects cannot recover this event.
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          params.eventId,
          {
            version: IRC_INGRESS_PAYLOAD_VERSION,
            eventId: params.eventId,
            receivedAt: params.receivedAt,
            connectionEpoch,
            connectedNick,
            rawLine: params.rawLine,
          },
          { receivedAt: params.receivedAt, laneKey },
        );
        requestDrain();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  return {
    openConnection: (connectionEpoch = randomUUID()) => {
      const epoch = connectionEpoch.trim();
      if (!epoch) {
        throw new Error("IRC ingress connection epoch is required.");
      }
      let sequence = 0;
      return {
        connectionEpoch: epoch,
        accept: (rawLine, connectedNick) => {
          if (stopped) {
            return Promise.reject(new Error("IRC ingress is stopped."));
          }
          sequence += 1;
          // IRC supplies no delivery id. This local id is stable after append,
          // monotonic within one TCP connection, and never derived from content.
          const eventId = `local:${epoch}:${String(sequence).padStart(12, "0")}`;
          const receivedAt = Date.now();
          const admission = admissionTail.then(async () => {
            await admitOnce({
              eventId,
              rawLine,
              receivedAt,
              connectionEpoch: epoch,
              connectedNick,
            });
          });
          admissionTail = admission.catch(() => undefined);
          return admission;
        },
      };
    },
    start: () => {
      if (stopped) {
        return;
      }
      if (!running) {
        running = true;
        pollTimer = setInterval(
          requestDrain,
          options.pollIntervalMs ?? IRC_INGRESS_POLL_INTERVAL_MS,
        );
        pollTimer.unref?.();
      }
      requestDrain();
    },
    pause,
    stop: async () => {
      if (stopped) {
        await admissionTail;
        return;
      }
      stopped = true;
      const paused = pause();
      // Every callback accepted before stop must finish its durable append.
      await admissionTail;
      shutdown.abort();
      drain?.dispose();
      await paused;
      // A pump may have created the lazy drain before observing running=false.
      drain?.dispose();
      await drain?.waitForIdle();
    },
    waitForIdle: async () => {
      await admissionTail;
      for (;;) {
        const activePump = pumping;
        if (!activePump) {
          break;
        }
        await activePump;
      }
      await drain?.waitForIdle();
    },
  };
}
