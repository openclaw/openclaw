import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NotificationRouter,
  WebhookChannel,
  type NotificationChannel,
} from "./notification-router.js";

// ── Helpers ──

function makeEvent(overrides?: Partial<{ id: string; type: string; title: string; detail: string; timestamp: number }>) {
  return {
    id: "evt-1",
    type: "trade_executed",
    title: "BTC Buy Filled",
    detail: "Bought 0.1 BTC at $60,000",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMockChannel(id: string, opts?: { enabled?: boolean; fail?: boolean }): NotificationChannel {
  const enabled = opts?.enabled ?? true;
  const fail = opts?.fail ?? false;
  return {
    id,
    name: `Channel-${id}`,
    enabled,
    send: vi.fn().mockResolvedValue(
      fail ? { success: false, error: "send failed" } : { success: true },
    ),
  };
}

// ── NotificationRouter ──

describe("NotificationRouter", () => {
  let router: NotificationRouter;

  beforeEach(() => {
    router = new NotificationRouter();
  });

  it("notify() sends to webhook channel successfully", async () => {
    const ch = makeMockChannel("webhook");
    router.registerChannel(ch);

    const results = await router.notify(makeEvent());

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ channel: "webhook", success: true });
    expect(ch.send).toHaveBeenCalledOnce();
  });

  it("notify() handles webhook failure", async () => {
    const ch = makeMockChannel("webhook", { fail: true });
    router.registerChannel(ch);

    const results = await router.notify(makeEvent());

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ channel: "webhook", success: false, error: "send failed" });
  });

  it("notify() sends to multiple channels", async () => {
    const ch1 = makeMockChannel("webhook");
    const ch2 = makeMockChannel("slack");
    router.registerChannel(ch1);
    router.registerChannel(ch2);

    const results = await router.notify(makeEvent());

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.channel).sort()).toEqual(["slack", "webhook"]);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("notify() skips disabled channels", async () => {
    const enabled = makeMockChannel("webhook");
    const disabled = makeMockChannel("slack", { enabled: false });
    router.registerChannel(enabled);
    router.registerChannel(disabled);

    const results = await router.notify(makeEvent());

    expect(results).toHaveLength(1);
    expect(results[0]!.channel).toBe("webhook");
    expect(disabled.send).not.toHaveBeenCalled();
  });

  it("notify() with specific channel filter", async () => {
    const ch1 = makeMockChannel("webhook");
    const ch2 = makeMockChannel("slack");
    router.registerChannel(ch1);
    router.registerChannel(ch2);

    const results = await router.notify(makeEvent(), ["slack"]);

    expect(results).toHaveLength(1);
    expect(results[0]!.channel).toBe("slack");
    expect(ch1.send).not.toHaveBeenCalled();
    expect(ch2.send).toHaveBeenCalledOnce();
  });

  it("registerChannel() adds new channel", () => {
    const ch = makeMockChannel("webhook");
    router.registerChannel(ch);

    const channels = router.listChannels();
    expect(channels).toEqual([{ id: "webhook", name: "Channel-webhook", enabled: true }]);
  });

  it("listChannels() returns registered channels info", () => {
    router.registerChannel(makeMockChannel("webhook"));
    router.registerChannel(makeMockChannel("slack", { enabled: false }));

    const channels = router.listChannels();
    expect(channels).toHaveLength(2);
    expect(channels).toEqual([
      { id: "webhook", name: "Channel-webhook", enabled: true },
      { id: "slack", name: "Channel-slack", enabled: false },
    ]);
  });

  it("notify() returns empty array when no channels registered", async () => {
    const results = await router.notify(makeEvent());
    expect(results).toEqual([]);
  });
});

// ── WebhookChannel ──

describe("WebhookChannel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct JSON payload", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const channel = new WebhookChannel(["https://example.com/hook"]);
    const event = makeEvent({ timestamp: 1000 });
    await channel.send(event);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://example.com/hook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts.body as string);
    expect(body.event).toEqual(event);
    expect(body.source).toBe("fin-core");
    expect(typeof body.timestamp).toBe("number");
  });

  it("retries once on failure then succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const channel = new WebhookChannel(["https://example.com/hook"]);
    const result = await channel.send(makeEvent());

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns error after retry exhausted", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"));
    vi.stubGlobal("fetch", mockFetch);

    const channel = new WebhookChannel(["https://example.com/hook"]);
    const result = await channel.send(makeEvent());

    expect(result.success).toBe(false);
    expect(result.error).toContain("fail-2");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
