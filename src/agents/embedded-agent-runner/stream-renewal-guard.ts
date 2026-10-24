import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
} from "../../llm/types.js";
import { isTokenExpiredUnauthorizedTerminal } from "./run/auth-store.js";

/**
 * Buffers a provider stream until its first output event so a request that the
 * provider rejected before producing anything can be retried exactly once:
 *
 * - `start` events are held back while buffering; every other event either
 *   flushes the buffer (output started: live pass-through) or is terminal.
 * - A terminal `error` event carrying a structured 401 token-expiry while
 *   still buffering consults `onUnauthorizedExpiry`. A replacement stream is
 *   iterated in its place, still buffered; otherwise the buffered events and
 *   the terminal event are forwarded unchanged.
 * - After any output event is forwarded the stream passes through untouched:
 *   partial output or settled tool work is never replayed.
 *
 * The single renewal budget is carried by the handler the caller installs:
 * the replacement stream's handler returns `null`, so any further pre-output
 * expiry on it (or the original stream) surfaces terminally without looping.
 *
 * The wrapper shares one iterator between event consumption and `result()`,
 * matching the core's iterate-then-result consumption pattern.
 */
export function createRenewalGuardedStream(params: {
  source: AssistantMessageEventStreamLike;
  onUnauthorizedExpiry: (
    terminal: AssistantMessage,
  ) => Promise<AssistantMessageEventStreamLike | null>;
}): AssistantMessageEventStreamLike {
  let settled: AssistantMessage | undefined;
  let draining: Promise<void> | undefined;
  let consumed = false;

  async function* events(): AsyncGenerator<AssistantMessageEvent> {
    let current = params.source;
    let buffering = true;
    // Classification applies only to the source this guard was created for.
    // A replacement stream carries its own (spent) budget, so its pre-output
    // expiry must pass through untouched instead of looping.
    let classify = true;
    const buffered: AssistantMessageEvent[] = [];
    const flushBuffered = () => {
      const held = buffered.splice(0);
      return held;
    };
    outer: while (true) {
      for await (const event of current) {
        if (event.type === "error") {
          if (classify && buffering && isTokenExpiredUnauthorizedTerminal(event.error)) {
            const replacement = await params.onUnauthorizedExpiry(event.error);
            if (replacement) {
              // The abandoned request's held starts belong to a response the
              // consumer never saw; the replacement stream carries its own
              // and is buffered the same way. The replacement's handler has
              // no renewal budget left, so its pre-output expiry is terminal.
              flushBuffered();
              current = replacement;
              classify = false;
              continue outer;
            }
          }
          for (const held of flushBuffered()) {
            yield held;
          }
          settled = event.error;
          yield event;
          return;
        }
        if (event.type === "start") {
          if (buffering) {
            buffered.push(event);
          } else {
            yield event;
          }
          continue;
        }
        if (buffering) {
          buffering = false;
          for (const held of flushBuffered()) {
            yield held;
          }
        }
        yield event;
        if (event.type === "done") {
          settled = event.message;
          return;
        }
      }
      // The source ended without a terminal event; release held starts so the
      // consumer never observes a stream that only began.
      for (const held of flushBuffered()) {
        yield held;
      }
      return;
    }
  }

  return {
    [Symbol.asyncIterator]() {
      consumed = true;
      return events();
    },
    async result() {
      if (settled) {
        return settled;
      }
      if (draining) {
        await draining;
      } else if (consumed) {
        // The consumer drained the stream; the terminal was lost only if the
        // source ended without one, which the core treats as a contract break.
      } else {
        draining = (async () => {
          for await (const _ of this) {
            // Drive the guarded stream to its terminal.
          }
        })();
        await draining;
      }
      if (!settled) {
        throw new Error("Model stream ended without a terminal message");
      }
      return settled;
    },
  };
}
