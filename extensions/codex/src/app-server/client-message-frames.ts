import type { RpcRequest, RpcResponse } from "./protocol.js";

const UNPAIRED_SURROGATE_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** One byte reader owns framing and stops at an asynchronous page decode. */
export function listenCodexAppServerLines(
  input: NodeJS.ReadableStream,
  onLine: (line: Buffer) => void | Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let fragments: Buffer[] = [];
  let length = 0;
  let remainder: Buffer | undefined;
  let waiting = false;
  let ended = false;
  let closed = false;
  const close = () => {
    closed = true;
    fragments = [];
    remainder = undefined;
    input.off("data", onData);
    input.off("end", onEnd);
    input.pause();
  };
  const deliver = (tail: Buffer): boolean => {
    const line = fragments.length
      ? Buffer.concat([...fragments, tail], length + tail.length)
      : tail;
    fragments = [];
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
          // Retain only this already-delivered transport chunk, never a page queue.
          remainder = chunk.subarray(end + 1);
          if (!deliver(chunk.subarray(start, end))) {
            return;
          }
          remainder = undefined;
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

export type CodexCatalogResponseRoute = { id: number; kind: "list" | "thread" };
export type CodexCatalogDecodeRoute = CodexCatalogResponseRoute | "unresolved";

export function codexCatalogResponseRoute(
  id: number | string,
): CodexCatalogResponseRoute | undefined {
  return typeof id === "number" && Number.isSafeInteger(id) && id >= 2 ** 52
    ? { id, kind: id % 2 === 1 ? "list" : "thread" }
    : undefined;
}

/** Read bounded envelope keys and IDs; skip native payload strings as bytes. */
export function readCodexCatalogDecodeRoute(line: Buffer): CodexCatalogDecodeRoute | undefined {
  let depth = 0;
  let route: CodexCatalogResponseRoute | undefined;
  let response = false;
  for (let index = 0; index < line.length; index++) {
    const byte = line[index];
    if (byte === 123 || byte === 91) {
      depth++;
    } else if (byte === 125 || byte === 93) {
      depth--;
    } else if (byte === 34) {
      const start = index;
      for (;;) {
        index = line.indexOf(34, index + 1);
        if (index < 0) {
          // A raw newline may precede the ID in a result-first envelope. Keep
          // recovery off-main until the decoded ID can select its projection.
          return "unresolved";
        }
        let slash = index - 1;
        while (line[slash] === 92) {
          slash--;
        }
        if ((index - slash) % 2 === 1) {
          break;
        }
      }
      if (depth !== 1 || index - start > 64) {
        continue;
      }
      let colon = index + 1;
      while (line[colon] === 32 || line[colon] === 9 || line[colon] === 13) {
        colon++;
      }
      if (line[colon] !== 58) {
        continue;
      }
      const token = line.toString("utf8", start, index + 1);
      let key: unknown = token.slice(1, -1);
      if (token.includes("\\")) {
        try {
          key = JSON.parse(token);
        } catch {
          return "unresolved";
        }
      }
      if (key === "method") {
        return undefined;
      }
      if (key === "result" || key === "error") {
        response = true;
        if (route) {
          return route;
        }
      }
      if (key !== "id") {
        continue;
      }
      const match = /^\s*:\s*(\d+)(?=\s*[,}])/u.exec(
        line.toString("utf8", index + 1, Math.min(index + 100, line.length)),
      );
      if (!match) {
        continue;
      }
      route = codexCatalogResponseRoute(Number(match[1]));
      if (!route || response) {
        return route;
      }
    }
  }
  return response || route ? "unresolved" : undefined;
}

export function stringifyCodexAppServerMessage(message: RpcRequest | RpcResponse): string {
  return (
    JSON.stringify(message, (_key, value) =>
      typeof value === "string" ? value.replace(UNPAIRED_SURROGATE_RE, "") : value,
    ) ?? "null"
  );
}
