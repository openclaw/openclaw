import { describe, expect, it, vi } from "vitest";
import type { ResolvedAgentMailAccount } from "./types.js";
import { startAgentMailWebSocket } from "./websocket.js";

const handlers = new Map<string, (value?: unknown) => void>();
const sendSubscribe = vi.fn();
const close = vi.fn();
const waitForOpen = vi.fn(async () => undefined);
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
    const receive = vi.fn(async () => undefined);
    const controller = new AbortController();
    const running = startAgentMailWebSocket({
      account,
      abortSignal: controller.signal,
      receive,
    });
    await vi.waitFor(() => expect(handlers.has("open")).toBe(true));
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ reconnectAttempts: Number.POSITIVE_INFINITY }),
    );
    expect(waitForOpen).not.toHaveBeenCalled();
    handlers.get("open")?.();
    handlers.get("close")?.();
    handlers.get("open")?.();
    expect(sendSubscribe).toHaveBeenCalledTimes(2);
    expect(sendSubscribe).toHaveBeenLastCalledWith({
      type: "subscribe",
      inboxIds: ["inbox_1"],
      eventTypes: ["message.received"],
    });

    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      eventId: "event_1",
      message: { inboxId: "inbox_1", messageId: "message_1" },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(receive).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: "inbox_1",
        messageId: "message_1",
        transport: "websocket",
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
    });
    await vi.waitFor(() => expect(handlers.has("message")).toBe(true));
    handlers.get("message")?.({
      type: "event",
      eventType: "message.received",
      message: { inboxId: "inbox_1", messageId: "message_retry" },
    });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    controller.abort();
    await running;
  });
});
