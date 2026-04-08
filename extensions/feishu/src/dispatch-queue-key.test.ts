import { describe, expect, it, vi } from "vitest";
import { resolveFeishuDispatchQueueKey } from "./dispatch-queue-key.js";

/**
 * Minimal re-implementation of createChatQueue (private in monitor.account.ts)
 * for integration testing. This mirrors the exact same serial-chain logic.
 */
function createChatQueue() {
  const queues = new Map<string, Promise<void>>();
  return (key: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
    return next;
  };
}

describe("resolveFeishuDispatchQueueKey", () => {
  // ─── Unit tests: pure queue key resolution ────────────────────────

  it("routes /stop to the control queue", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "/stop",
      }),
    ).toBe("oc_abc123:control");
  });

  it("routes bare 'stop' to the control queue", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "stop",
      }),
    ).toBe("oc_abc123:control");
  });

  it("routes 'halt' to the control queue", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "halt",
      }),
    ).toBe("oc_abc123:control");
  });

  it("returns plain chatId for normal messages", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "hello world",
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId for non-abort slash commands like /model", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "/model",
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId for /status (not an abort command)", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "/status",
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId for /new (not an abort command)", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "/new",
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId when message text is empty", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "",
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId when message text is whitespace-only", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "   ",
      }),
    ).toBe("oc_abc123");
  });

  it("trims message text before checking", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "  /stop  ",
      }),
    ).toBe("oc_abc123:control");
  });

  it("uses different control queue keys for different chats", () => {
    const key1 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
    });
    const key2 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat2",
      messageText: "/stop",
    });
    expect(key1).toBe("oc_chat1:control");
    expect(key2).toBe("oc_chat2:control");
    expect(key1).not.toBe(key2);
  });

  it("is case-insensitive for abort keywords", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc",
        messageText: "/STOP",
      }),
    ).toBe("oc_abc:control");
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc",
        messageText: "Stop",
      }),
    ).toBe("oc_abc:control");
  });

  // ─── Queue isolation: abort commands bypass active runs ───────────

  it("abort command executes immediately while a long task is running on the same chat", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseLongTask!: () => void;
    const longTaskGate = new Promise<void>((resolve) => {
      releaseLongTask = resolve;
    });

    // 1. Enqueue a long-running agent task on "oc_chat1" (normal queue)
    const normalKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "explain quantum computing in detail",
    });
    const longTaskPromise = enqueue(normalKey, async () => {
      events.push("long-task-start");
      await longTaskGate;
      events.push("long-task-end");
    });

    await vi.waitFor(() => expect(events).toContain("long-task-start"));

    // 2. Enqueue /stop on the CONTROL queue for the same chat
    const controlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
    });
    expect(controlKey).not.toBe(normalKey);

    const stopPromise = enqueue(controlKey, async () => {
      events.push("stop-executed");
    });

    // 3. /stop should complete before the long task finishes
    await stopPromise;
    expect(events).toContain("stop-executed");
    expect(events).not.toContain("long-task-end");

    // 4. Clean up
    releaseLongTask();
    await longTaskPromise;
    expect(events).toEqual(["long-task-start", "stop-executed", "long-task-end"]);
  });

  it("normal messages on the same chat still serialize behind each other", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const key1 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "first message",
    });
    const key2 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "second message",
    });
    expect(key1).toBe(key2);

    const p1 = enqueue(key1, async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    });
    const p2 = enqueue(key2, async () => {
      events.push("second-start");
    });

    await vi.waitFor(() => expect(events).toContain("first-start"));
    expect(events).not.toContain("second-start");

    releaseFirst();
    await p1;
    await p2;

    expect(events).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("abort commands from different chats do not interfere with each other", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseChat1Stop!: () => void;
    const chat1StopGate = new Promise<void>((resolve) => {
      releaseChat1Stop = resolve;
    });

    const chat1ControlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
    });
    const chat2ControlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat2",
      messageText: "/stop",
    });
    expect(chat1ControlKey).not.toBe(chat2ControlKey);

    const p1 = enqueue(chat1ControlKey, async () => {
      events.push("chat1-stop-start");
      await chat1StopGate;
      events.push("chat1-stop-end");
    });

    await vi.waitFor(() => expect(events).toContain("chat1-stop-start"));

    const p2 = enqueue(chat2ControlKey, async () => {
      events.push("chat2-stop-executed");
    });

    await p2;
    expect(events).toContain("chat2-stop-executed");
    expect(events).not.toContain("chat1-stop-end");

    releaseChat1Stop();
    await p1;
  });

  it("multiple abort commands on the same chat serialize among themselves", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseFirstControl!: () => void;
    const firstControlGate = new Promise<void>((resolve) => {
      releaseFirstControl = resolve;
    });

    const controlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
    });

    const p1 = enqueue(controlKey, async () => {
      events.push("first-control-start");
      await firstControlGate;
      events.push("first-control-end");
    });

    await vi.waitFor(() => expect(events).toContain("first-control-start"));

    const p2 = enqueue(controlKey, async () => {
      events.push("second-control-start");
    });

    expect(events).not.toContain("second-control-start");

    releaseFirstControl();
    await p1;
    await p2;

    expect(events).toEqual(["first-control-start", "first-control-end", "second-control-start"]);
  });

  it("a queued normal message does not block a subsequent abort command", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseTask1!: () => void;
    const task1Gate = new Promise<void>((resolve) => {
      releaseTask1 = resolve;
    });
    let releaseTask2!: () => void;
    const task2Gate = new Promise<void>((resolve) => {
      releaseTask2 = resolve;
    });

    const normalKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "first task",
    });
    const controlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
    });

    const p1 = enqueue(normalKey, async () => {
      events.push("task1-start");
      await task1Gate;
      events.push("task1-end");
    });
    const p2 = enqueue(normalKey, async () => {
      events.push("task2-start");
      await task2Gate;
      events.push("task2-end");
    });

    await vi.waitFor(() => expect(events).toContain("task1-start"));

    const pStop = enqueue(controlKey, async () => {
      events.push("stop-executed");
    });

    await pStop;
    expect(events).toContain("stop-executed");
    expect(events).not.toContain("task1-end");
    expect(events).not.toContain("task2-start");

    releaseTask1();
    await p1;
    releaseTask2();
    await p2;
  });
});
