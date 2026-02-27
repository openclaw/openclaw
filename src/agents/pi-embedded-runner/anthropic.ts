import type { AgentMessage } from "@mariozechner/pi-agent-core";

const THINKING_BLOCK_ERROR_PATTERN = /thinking or redacted_thinking blocks?.* cannot be modified/i;

// The stream function signature is dynamic and determined by pi-coding-agent internals.
type StreamFn = (...args: unknown[]) => AsyncIterable<unknown>;

export function wrapAnthropicStreamWithRecovery(
  innerStreamFn: StreamFn,
  sessionMeta: { id: string; recovered?: boolean },
): StreamFn {
  return async function* (model: unknown, context: unknown, options: unknown) {
    const ctx = context as Record<string, unknown> | undefined;
    try {
      const generator = innerStreamFn(model, context, options);
      for await (const chunk of generator) {
        yield chunk;
      }
    } catch (err: unknown) {
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
        const stripped = msg.content.filter(
          (block) => block?.type !== "thinking" && block?.type !== "redacted_thinking",
        );
        if (stripped.length === 0) {
          return { ...msg, content: [{ type: "text", text: "" }] };
        }
        return { ...msg, content: stripped };
      });

      sessionMeta.recovered = true;
      const newContext = { ...ctx, messages: cleaned };

      const retryGenerator = innerStreamFn(model, newContext, options);
      for await (const chunk of retryGenerator) {
        yield chunk;
      }
    }
  };
}
