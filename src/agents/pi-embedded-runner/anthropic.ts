import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";

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

    // Get the stream from inner function
    const streamOrPromise = innerStreamFn(model, context, options);

    // If it's a promise, wrap it to catch errors
    if (streamOrPromise instanceof Promise) {
      return streamOrPromise.catch((err: unknown) => {
        return handleStreamError(err, innerStreamFn, model, ctx, context, options, sessionMeta);
      }) as ReturnType<StreamFn>;
    }

    // For sync streams, we can't easily intercept errors without consuming the stream
    // The error will propagate through the normal path
    return streamOrPromise;
  };
  return wrapped;
}

function handleStreamError(
  err: unknown,
  innerStreamFn: StreamFn,
  model: Parameters<StreamFn>[0],
  ctx: Record<string, unknown> | undefined,
  context: Parameters<StreamFn>[1],
  options: Parameters<StreamFn>[2],
  sessionMeta: { id: string; recovered?: boolean },
): ReturnType<StreamFn> {
  const errMsg = err instanceof Error ? err.message : String(err);

  if (!THINKING_BLOCK_ERROR_PATTERN.test(errMsg)) {
    throw err;
  }
  if (sessionMeta.recovered) {
    console.error(
      `[session-recovery] Session ${sessionMeta.id}: thinking block error ` +
        `persists after recovery. Not retrying again.`,
    );
    throw err;
  }

  console.warn(
    `[session-recovery] Session ${sessionMeta.id}: thinking block error. ` +
      `Nuclear fallback: stripping ALL thinking blocks, retrying once.`,
  );

  // Nuclear: strip ALL thinking from ALL messages
  const messages = Array.isArray(ctx?.messages) ? (ctx.messages as AgentMessage[]) : [];
  const cleaned = messages.map((msg) => {
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      return msg;
    }
    const stripped = (msg.content as Array<{ type?: string }>).filter(
      (block) => block?.type !== "thinking" && block?.type !== "redacted_thinking",
    );
    if (stripped.length === 0) {
      return { ...msg, content: [{ type: "text", text: "" }] };
    }
    return { ...msg, content: stripped };
  });

  sessionMeta.recovered = true;
  const newContext = { ...ctx, messages: cleaned } as unknown as typeof context;

  return innerStreamFn(model, newContext, options);
}
