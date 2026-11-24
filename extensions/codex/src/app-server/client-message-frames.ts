import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import type { RpcRequest, RpcResponse } from "./protocol.js";
import type { CodexAppServerTransport } from "./transport.js";

export function createCodexAppServerMessageWriter(options: {
  getTransport: () => CodexAppServerTransport;
  isClosed: () => boolean;
  onNativeExecution: () => void;
}) {
  return (
    message: RpcRequest | RpcResponse,
    onError?: (error: Error) => void,
    beforeWrite?: () => void,
  ): void => {
    if (options.isClosed()) {
      return;
    }
    const child = options.getTransport();
    const id = "id" in message ? message.id : undefined;
    const method = "method" in message ? message.method : undefined;
    const frame =
      JSON.stringify(message, (_key, value) =>
        typeof value === "string" ? value.replace(UNPAIRED_SURROGATE_RE, "") : value,
      ) ?? "null";
    // Reject locally before declaring a possible write. Images count toward the
    // transport frame limit even though Codex's text-input limit excludes them.
    if (child.maxFrameBytes && Buffer.byteLength(frame) > child.maxFrameBytes) {
      throw new Error(
        "Codex request exceeds the transport frame limit; reduce attached images or context.",
      );
    }
    beforeWrite?.();
    if (method === "command/exec") {
      options.onNativeExecution();
    }
    child.stdin.write(`${frame}\n`, (error?: Error | null) => {
      if (error) {
        embeddedAgentLog.warn("codex app-server write failed", { error, id, method });
        onError?.(error);
      }
    });
  };
}

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One byte reader owns framing and stops at an asynchronous page decode. */
export function listenCodexAppServerLines(
  input: NodeJS.ReadableStream,
  onLine: (line: Buffer) => void | Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  const fragments: Buffer[] = [];
  let length = 0;
  let remainder: Buffer | undefined;
  let waiting = false;
  let ended = false;
  let closed = false;
  const close = () => {
    closed = true;
    fragments.length = 0;
    remainder = undefined;
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
  };
  const deliver = (tail: Buffer): boolean => {
    let line = tail;
    if (fragments.length) {
      fragments.push(tail);
      line = Buffer.concat(fragments, length + tail.length);
    }
    fragments.length = 0;
    length = 0;
    const completion = onLine(line);
    if (!completion) {
      return true;
    }
    waiting = true;
    input.pause();
    void completion
      .then(() => {
        waiting = false;
        if (!closed) {
          drain();
          if (!waiting && !ended && !closed) {
            input.resume();
          }
        }
      })
      .catch((error: unknown) => {
        close();
        onError(error);
      });
    return false;
  };
  const drain = () => {
    try {
      const chunk = remainder;
      remainder = undefined;
      if (chunk) {
        let start = 0;
        let end: number;
        while ((end = chunk.indexOf(10, start)) !== -1) {
          if (closed) {
            return;
          }
          if (!deliver(chunk.subarray(start, end))) {
            // Retain this chunk only while an asynchronous decode pauses delivery.
            remainder = closed ? undefined : chunk.subarray(end + 1);
            return;
          }
          start = end + 1;
        }
        if (!closed && start < chunk.length) {
          fragments.push(chunk.subarray(start));
          length += chunk.length - start;
        }
      }
      if (ended && !closed) {
        if (length && !deliver(Buffer.alloc(0))) {
          return;
        }
        close();
      }
    } catch (error) {
      close();
      onError(error);
    }
  };
  const onData = (chunk: Buffer) => {
    remainder = chunk;
    drain();
  };
  const onEnd = () => {
    ended = true;
    if (!waiting) {
      drain();
    }
  };
  input.on("data", onData);
  input.once("end", onEnd);
  return close;
}
