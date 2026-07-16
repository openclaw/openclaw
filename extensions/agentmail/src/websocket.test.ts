import { describe, expect, it, vi } from "vitest";
import { AgentMailIngressCapacityError } from "./ingress.js";
import type { ResolvedAgentMailAccount } from "./types.js";
import { startAgentMailWebSocket } from "./websocket.js";

const handlers = new Map<string, (value?: unknown) => void>();
const sendSubscribe = vi.fn();
const close = vi.fn();
const waitForOpen = vi.fn(async () => undefined);
const catchUpRun = vi.fn(async () => undefined);
const connect = vi.fn(async () => ({
  on: (event: string, handler: (value?: unknown) => void) => handlers.set(event, handler),
  sendSubscribe,
  waitForOpen,
  readyState: 0,
  close,
}));

vi.mock("./client.js", () => ({
  createAgentMailClient: () => ({
    websockets: { connect },
  }),
}));

const account: ResolvedAgentMailAccount = {
  accountId: "default",
  enabled: true,
  apiKey: "key",
  inboxId: "inbox_1",
  webhookSecret: "",
  webhookPath: "/webhooks/agentmail",
  dmPolicy: "allowlist",
  allowFrom: ["sender@example.com"],
  mediaMaxBytes: 20 * 1024 * 1024,
};

describe("AgentMail WebSocket ingress", () => {
  it("re-subscribes after every open and normalizes received events", async () => {
    handlers.clear();
    sendSubscribe.mockClear();
    close.mockClear();
    connect.mockClear();
    catchUpRun.mockClear();
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        reconnectAttempts: Number.POSITIVE_INFINITY,
        waitForOpen: false,
      }),
    );
    expect(waitForOpen).not.toHaveBeenCalled();
    handlers.get("open")?.();
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    handlers.get("close")?.();
    handlers.get("open")?.();
    expect(sendSubscribe).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledTimes(2));
    expect(sendSubscribe).toHaveBeenLastCalledWith({
      type: "subscribe",
      inboxIds: ["inbox_1"],
      eventTypes: ["message.received"],
    });

    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      eventId: "event_1",
      message: {
        inboxId: "inbox_1",
        messageId: "message_1",
        timestamp: new Date(1_234),
      },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: "inbox_1",
        messageId: "message_1",
        transport: "websocket",
        receivedAt: 1_234,
      }),
    );
    controller.abort();
    await running;
    expect(close).toHaveBeenCalledOnce();
  });

  it("stops cleanly when aborted before the initial socket opens", async () => {
    handlers.clear();
    close.mockClear();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
    expect(waitForOpen).not.toHaveBeenCalled();
  });

  it("retries until a WebSocket event is durably admitted", async () => {
    handlers.clear();
    const receive = vi
      .fn<(record: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new Error("queue unavailable"))
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: receive as never,
      retryDelayMs: () => 0,
      catchUpSession: { run: catchUpRun },
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: {
        inboxId: "inbox_1",
        messageId: "message_retry",
        timestamp: new Date(1_234),
      },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    controller.abort();
    await running;
  });

  it("bounds live admission and uses REST catch-up for overflow", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    let finishReceive!: () => void;
    const receive = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          finishReceive = resolve;
        }),
    );
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
      catchUpSession: { run: catchUpRun },
      liveQueueMax: 1,
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: { inboxId: "inbox_1", messageId: "message_1", timestamp: new Date(1_234) },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: { inboxId: "inbox_1", messageId: "message_2", timestamp: new Date(1_235) },
    });
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledOnce();

    finishReceive();
    controller.abort();
    await running;
  });

  it("defers capacity-blocked events to REST catch-up without pinning the live worker", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    const receive = vi
      .fn<(record: unknown) => Promise<void>>()
      .mockRejectedValueOnce(new AgentMailIngressCapacityError())
      .mockResolvedValueOnce(undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: receive as never,
      retryDelayMs: () => 0,
      catchUpSession: { run: catchUpRun },
      liveQueueMax: 2,
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: { inboxId: "inbox_1", messageId: "message_full", timestamp: new Date(1_234) },
    });
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: { inboxId: "inbox_1", messageId: "message_next", timestamp: new Date(1_235) },
    });

    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    controller.abort();
    await running;
  });

  it("runs periodic REST catch-up even without a socket lifecycle event", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      catchUpIntervalMs: 1,
    });
    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalled());
    controller.abort();
    await running;
  });

  it("reports SDK errors and schedules authoritative catch-up", async () => {
    handlers.clear();
    catchUpRun.mockClear();
    const error = vi.fn();
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive: vi.fn(async () => undefined),
      catchUpSession: { run: catchUpRun },
      log: { error },
    });
    await vi.waitFor(() => expect(handlers.has("error")).toBe(true));

    handlers.get("error")?.(new Error("frame parse failed"));

    await vi.waitFor(() => expect(catchUpRun).toHaveBeenCalledOnce());
    expect(error).toHaveBeenCalledWith(
      "AgentMail WebSocket error for account default: frame parse failed",
    );
    controller.abort();
    await running;
  });
});
