// Discord tests cover bounded webhook JSON response reads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn(() => ({ channels: { discord: {} } })));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return { ...actual, requireRuntimeConfig: (cfg: unknown) => cfg ?? loadConfigMock() };
});

vi.mock("openclaw/plugin-sdk/channel-activity-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-activity-runtime")
  >("openclaw/plugin-sdk/channel-activity-runtime");
  return { ...actual, recordChannelActivity: vi.fn() };
});

let sendWebhookMessageDiscord: typeof import("./send.webhook.js").sendWebhookMessageDiscord;

const BASE_CFG = { channels: { discord: { token: "resolved-token" } } };

describe("sendWebhookMessageDiscord bounded JSON", () => {
  beforeAll(async () => {
    ({ sendWebhookMessageDiscord } = await import("./send.webhook.js"));
  });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const WH_OPTS = {
    cfg: BASE_CFG,
    webhookId: "wh-bounded",
    webhookToken: "tok-bounded",
    accountId: "runtime",
    threadId: "thread-bounded",
  };

  it("parses normal JSON webhook response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: "msg-normal", channel_id: "ch-normal" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await sendWebhookMessageDiscord("hello", WH_OPTS);

    expect(result.messageId).toBe("msg-normal");
    expect(result.channelId).toBe("ch-normal");
  });

  it("rejects oversized webhook response exceeding the 1 MiB cap", async () => {
    // 2 MiB body > 1 MiB cap in send.webhook.ts
    const bigBody = "x".repeat(2 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bigBody, {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(sendWebhookMessageDiscord("hello", WH_OPTS)).rejects.toThrow(
      "Discord webhook JSON response too large",
    );
  });

  it("falls back to empty payload on empty success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await sendWebhookMessageDiscord("hello", WH_OPTS);

    // Empty body → JSON.parse fails → fallback to {} → generates a receipt
    expect(result).toBeDefined();
    expect(result.channelId).toBe("thread-bounded");
  });

  it("falls back to empty payload on malformed JSON success response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("NOT JSON {{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const result = await sendWebhookMessageDiscord("hello", WH_OPTS);

    // Malformed JSON → parse fails → fallback to {} → generates a receipt
    expect(result).toBeDefined();
    expect(result.channelId).toBe("thread-bounded");
  });
});
