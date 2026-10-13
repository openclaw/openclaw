import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  QuicksilverSocketCommand,
  QuicksilverSocketMessage,
} from "./realtime-quicksilver-socket.shared.js";

const { createWorkerMock } = vi.hoisted(() => ({ createWorkerMock: vi.fn() }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: function MockWorker() {
      return createWorkerMock();
    },
  };
});

import { OpenAIQuicksilverWorkerSocket } from "./realtime-quicksilver-socket.js";

class ControlledWorker extends EventEmitter {
  readonly commands: QuicksilverSocketCommand[] = [];
  readonly terminate = vi.fn(async () => {
    this.emit("exit", 1);
    return 1;
  });
  postMessage(command: QuicksilverSocketCommand): void {
    this.commands.push(command);
  }
  message(message: QuicksilverSocketMessage): void {
    this.emit("message", message);
  }
}

function connect(open = true) {
  const worker = new ControlledWorker();
  createWorkerMock.mockReturnValue(worker);
  const socket = OpenAIQuicksilverWorkerSocket.create(
    "wss://realtime.invalid/private",
    {},
    { model: "gpt-live-1", paced: true },
    { onAudio() {} },
  );
  const onError = vi.fn();
  socket.on("error", onError);
  if (open) {
    worker.message({ type: "open" });
  }
  return { socket, worker, onError };
}

const start = JSON.stringify({ type: "session.start" });
const context = JSON.stringify({ type: "session.thinking.append", content: "accepted context" });
const final = JSON.stringify({ type: "session.close" });

afterEach(() => {
  vi.useRealTimers();
});

describe("GPT-Live worker socket control drain", () => {
  it("posts close before open and does not reopen on a late worker open", () => {
    const { socket, worker, onError } = connect(false);
    const onOpen = vi.fn();
    const onClose = vi.fn();
    socket.on("open", onOpen);
    socket.on("close", onClose);
    try {
      socket.close(1000, "startup canceled");
      expect(socket.readyState).toBe(2);
      expect(worker.commands).toContainEqual({
        type: "close",
        code: 1000,
        reason: "startup canceled",
      });
      worker.message({ type: "open" });
      expect(onOpen).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(2);
      worker.message({ type: "close", code: 1006, reason: "opening handshake canceled" });
      expect(onClose).toHaveBeenCalledWith(1006, Buffer.from("opening handshake canceled"));
      expect(onError).not.toHaveBeenCalled();
      expect(worker.terminate).not.toHaveBeenCalled();
    } finally {
      worker.emit("exit", 0);
    }
  });

  it("sends accepted context and session.close in FIFO order before transport close", () => {
    const { socket, worker, onError } = connect();
    try {
      socket.send(start);
      socket.send(context);
      socket.send(final);
      socket.close(1000, "fixture close");
      socket.close();
      socket.send("must not be admitted after close");
      socket.sendAudio(Buffer.alloc(960));
      expect(socket.readyState).toBe(2);
      expect(worker.commands.filter((command) => command.type === "send")).toEqual([
        { type: "send", payload: start },
      ]);
      expect(worker.commands).toContainEqual({ type: "stop-audio" });
      expect(worker.commands.some((command) => command.type === "close")).toBe(false);
      worker.message({ type: "send-ack" });
      expect(worker.commands.at(-1)).toEqual({ type: "send", payload: context });
      worker.message({ type: "send-ack" });
      expect(worker.commands.at(-1)).toEqual({ type: "send", payload: final });
      expect(worker.commands.some((command) => command.type === "close")).toBe(false);
      worker.message({ type: "send-ack" });
      expect(
        worker.commands.filter((command) => command.type === "send" || command.type === "close"),
      ).toEqual([
        { type: "send", payload: start },
        { type: "send", payload: context },
        { type: "send", payload: final },
        { type: "close", code: 1000, reason: "fixture close" },
      ]);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      worker.message({ type: "close", code: 1000, reason: "closed" });
      worker.emit("exit", 0);
    }
  });

  it("aborts a draining FIFO when the worker reports a transport failure", () => {
    const { socket, worker, onError } = connect();
    try {
      socket.send(start);
      socket.send(context);
      socket.send(final);
      socket.close();
      worker.message({ type: "error" });
      worker.message({ type: "send-ack" });
      expect(onError).toHaveBeenCalledOnce();
      expect(worker.commands.filter((command) => command.type === "send")).toEqual([
        { type: "send", payload: start },
      ]);
      expect(worker.commands.filter((command) => command.type === "close")).toEqual([
        { type: "close", code: 1011, reason: "media transport failed" },
      ]);
    } finally {
      worker.message({ type: "close", code: 1006, reason: "failed" });
      worker.emit("exit", 1);
    }
  });

  it("terminates an unacknowledged drain at the original close deadline", async () => {
    vi.useFakeTimers();
    const { socket, worker, onError } = connect();
    try {
      socket.send(start);
      socket.send(final);
      socket.close();
      await vi.advanceTimersByTimeAsync(1_000);
      socket.close();
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledOnce();
      expect(socket.readyState).toBe(3);
    } finally {
      worker.emit("exit", 1);
    }
  });
});
