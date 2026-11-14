import type { ServerResponse } from "node:http";
import { boundedJsonUtf8Bytes } from "openclaw/plugin-sdk/text-utility-runtime";
import type { A2aTaskRecord } from "./protocol.js";
import { isTerminalTask, type A2aTaskStore } from "./task-store.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const STREAM_LIFETIME_MS = 120_000;

/** Observes one accepted Task. Disconnects and slow readers never own its execution. */
export function streamA2aTask(params: {
  response: ServerResponse;
  id: string | number | null;
  task: A2aTaskRecord;
  store: A2aTaskStore;
  signal: AbortSignal;
  isCurrent: () => boolean;
  release: () => void;
}): void {
  const { response, id, task, store, signal } = params;
  let closed = false;
  let blocked = false;
  let dirty = false;
  let stopObserving = () => {};
  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearTimeout(deadline);
    stopObserving();
    signal.removeEventListener("abort", abort);
    response.off("drain", drain);
    response.off("close", close);
    response.off("finish", close);
    response.off("error", abort);
    params.release();
  };
  const abort = () => {
    close();
    response.destroy();
  };
  // This also bounds a socket stuck while flushing its terminal update.
  const deadline = setTimeout(abort, STREAM_LIFETIME_MS);
  deadline.unref();
  const frame = (result: unknown) => {
    const value = { jsonrpc: "2.0", id, result };
    if (!boundedJsonUtf8Bytes(value, MAX_FRAME_BYTES).complete) {
      throw new Error("A2A stream frame exceeds the 1 MiB limit");
    }
    return `data: ${JSON.stringify(value).replace(
      /[\u0085\u2028\u2029]/g,
      (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )}\n\n`;
  };
  const write = (value: string) => {
    blocked = !response.write(value);
  };
  const end = () => {
    stopObserving();
    response.end();
  };
  const send = (snapshot: boolean) => {
    if (closed) {
      return;
    }
    // Account teardown can trail runtime-config publication. Recheck the captured
    // peer credential before any fresh write, including a delayed drain snapshot.
    try {
      if (!params.isCurrent()) {
        abort();
        return;
      }
    } catch {
      abort();
      return;
    }
    if (blocked) {
      // Retain one latest-state marker, never a queue of provider chunks.
      dirty = true;
      return;
    }
    try {
      const terminal = isTerminalTask(task);
      // An empty final must also retract a prior preview in subscribers' Task snapshots.
      if (snapshot || (terminal && task.artifacts.length === 0)) {
        write(frame({ task }));
      } else {
        let output = "";
        const artifact = task.artifacts[0];
        if (artifact) {
          output += frame({
            artifactUpdate: {
              taskId: task.id,
              contextId: task.contextId,
              artifact,
              append: false,
              lastChunk: terminal,
            },
          });
        }
        if (terminal) {
          output += frame({
            statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status },
          });
        }
        if (output) {
          write(output);
        }
      }
      if (terminal) {
        end();
      }
    } catch {
      // A refused frame does not replace the independently retained Task result.
      response.end(
        `data: ${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "A2A stream could not continue; read the original Task" },
        })}\n\n`,
      );
      stopObserving();
    }
  };
  function drain() {
    blocked = false;
    if (dirty) {
      dirty = false;
      // A full snapshot replaces any missed intermediate artifact updates.
      send(true);
    }
  }
  response.once("close", close);
  response.once("finish", close);
  response.once("error", abort);
  response.on("drain", drain);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted || response.destroyed || response.writableEnded) {
    abort();
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
  stopObserving = store.observe(task, () => send(false));
  send(true);
}
