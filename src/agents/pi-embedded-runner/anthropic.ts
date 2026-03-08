import type { StreamFn } from "@mariozechner/pi-agent-core";

const THINKING_BLOCK_ERROR_PATTERN = /thinking or redacted_thinking blocks?.* cannot be modified/i;

/**
 * Wraps a stream function to handle Anthropic's thinking block errors.
 * If the error matches the pattern and we haven't retried yet, strips all
 * thinking blocks and retries exactly once.
 */
export function wrapAnthropicStreamWithRecovery(
  innerStreamFn: StreamFn,
  sessionMeta: { id: string; recovered?: boolean },
): StreamFn {
  const wrapped: StreamFn = (model, context, options) => {
    const ctx = context as unknown as Record<string, unknown> | undefined;

    const attemptStream = () => innerStreamFn(model, context, options);
    const retryWithCleanedContext = () => {
      const cleaned = stripAllThinkingBlocks(ctx);
      const newContext = { ...ctx, messages: cleaned } as unknown as typeof context;
      return innerStreamFn(model, newContext, options);
    };

    const streamOrPromise = attemptStream();

    // Handle Promise-based returns (error at request time)
    if (streamOrPromise instanceof Promise) {
      return streamOrPromise.catch((err: unknown) => {
        if (shouldRecover(err, sessionMeta)) {
          sessionMeta.recovered = true;
          return retryWithCleanedContext();
        }
        throw err;
      }) as unknown as ReturnType<StreamFn>;
    }

    // For async iterables, wrap to catch errors during iteration
    return wrapAsyncIterableWithRecovery(
      streamOrPromise,
      sessionMeta,
      retryWithCleanedContext,
    ) as unknown as ReturnType<StreamFn>;
  };
  return wrapped;
}

function shouldRecover(err: unknown, sessionMeta: { id: string; recovered?: boolean }): boolean {
  const errMsg = err instanceof Error ? err.message : String(err);

  if (!THINKING_BLOCK_ERROR_PATTERN.test(errMsg)) {
    return false;
  }
  if (sessionMeta.recovered) {
    console.error(
      `[session-recovery] Session ${sessionMeta.id}: thinking block error ` +
        `persists after recovery. Not retrying again.`,
    );
    return false;
  }

  console.warn(
    `[session-recovery] Session ${sessionMeta.id}: thinking block error. ` +
      `Nuclear fallback: stripping ALL thinking blocks, retrying once.`,
  );
  return true;
}

interface ContentBlock {
  type?: string;
  [key: string]: unknown;
}

function stripAllThinkingBlocks(ctx: Record<string, unknown> | undefined): unknown[] {
  const messages = Array.isArray(ctx?.messages) ? ctx.messages : [];
  return messages.map((msg: unknown) => {
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      return msg;
    }
    const stripped = (m.content as ContentBlock[]).filter(
      (block) => block?.type !== "thinking" && block?.type !== "redacted_thinking",
    );
    if (stripped.length === 0) {
      return { ...m, content: [{ type: "text", text: "" }] };
    }
    return { ...m, content: stripped };
  });
}

async function* wrapAsyncIterableWithRecovery(
  stream: ReturnType<StreamFn>,
  sessionMeta: { id: string; recovered?: boolean },
  retryFn: () => ReturnType<StreamFn>,
): AsyncGenerator {
  try {
    const resolved = stream instanceof Promise ? await stream : stream;
    for await (const chunk of resolved as AsyncIterable<unknown>) {
      yield chunk;
    }
  } catch (err: unknown) {
    if (shouldRecover(err, sessionMeta)) {
      sessionMeta.recovered = true;
      const retryStream = retryFn();
      const resolvedRetry = retryStream instanceof Promise ? await retryStream : retryStream;
      for await (const chunk of resolvedRetry as AsyncIterable<unknown>) {
        yield chunk;
      }
      return;
    }
    throw err;
  }
}
