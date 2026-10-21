import * as channelActivity from "openclaw/plugin-sdk/channel-activity-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cancelTrackedTextResponse } from "../../test-support/streaming-error-response.js";
import { DiscordError } from "./internal/rest-errors.js";
import { DISCORD_REST_TIMEOUT_MS } from "./internal/rest.js";
import { maybeSendBindingMessage } from "./monitor/thread-bindings.discord-api.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.types.js";
import { discordOutbound } from "./outbound-adapter.js";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  mockDiscordBoundThreadManager,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

const realWebhookSend = sendWebhookMessageDiscord;
const hoisted = createDiscordOutboundHoisted();

async function withWebhookServer(
  reply: (content: string, index: number) => { status?: number; body: unknown },
  run: (contents: string[], references: Array<string | undefined>) => Promise<void>,
) {
  const contents: string[] = [];
  const references: Array<string | undefined> = [];
  await withServer(
    (request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        body += part;
      });
      request.on("end", () => {
        const { content, message_reference } = JSON.parse(body) as {
          content: string;
          message_reference?: { message_id: string };
        };
        references.push(message_reference?.message_id);
        contents.push(content);
        const next = reply(content, contents.length);
        response.writeHead(next.status ?? 200, { "content-type": "application/json" });
        response.end(JSON.stringify(next.body));
      });
    },
    async (baseUrl) => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const original =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const target = new URL(original);
        target.protocol = "http:";
        target.host = new URL(baseUrl).host;
        return realFetch(target, init);
      });
      try {
        await run(contents, references);
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );
}

const config = (mentionAliases?: Record<string, string>): OpenClawConfig => ({
  channels: { discord: { token: "Bot test-token", mentionAliases } },
});
const cfg = config();
const webhookOpts = { cfg, webhookId: "fixture", webhookToken: "fixture-token" };
const accepted = (_content: string, index: number) => ({
  body: { id: String(index), channel_id: "thread-1" },
});
function sendBound(
  text: string,
  sendConfig = config(),
  onDeliveryResult?: Parameters<
    NonNullable<typeof discordOutbound.sendText>
  >[0]["onDeliveryResult"],
) {
  mockDiscordBoundThreadManager(hoisted);
  return discordOutbound.sendText?.({
    cfg: sendConfig,
    to: "channel:parent-1",
    threadId: "thread-1",
    text,
    onDeliveryResult,
    onPlatformSendDispatch: async () => {},
  });
}

describe("Discord webhook delivery", () => {
  beforeEach(async () => {
    await installDiscordOutboundModuleSpies(hoisted);
    resetDiscordOutboundMocks(hoisted);
    hoisted.sendWebhookMessageDiscordMock.mockImplementation((...args) =>
      realWebhookSend(...(args as Parameters<typeof realWebhookSend>)),
    );
  });

  it("leaves already-planned tall webhook text intact when chunk options are omitted", async () => {
    const text = Array.from({ length: 20 }, (_, index) => `line-${index}`).join("\n");
    await withWebhookServer(accepted, async (contents, references) => {
      await realWebhookSend(text, { ...webhookOpts, replyTo: "legacy-reply" });
      expect(contents).toEqual([text]);
      expect(references).toEqual(["legacy-reply"]);
    });
  });

  it("resolves punctuated mentions outside code through bound-thread persona delivery", async () => {
    const text = "Example: `first\n@alice.`\nPlease review @alice. then `notify @alice.";
    await withWebhookServer(accepted, async (contents) => {
      await sendBound(text, config({ alice: "123456789" }));
      expect(contents).toEqual([
        "Example: `first\n@alice.`\nPlease review <@123456789>. then `notify @alice.",
      ]);
      expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
    });
  });

  it("reports every accepted physical webhook chunk", async () => {
    await withWebhookServer(accepted, async (contents) => {
      const progress: string[] = [];
      const result = await realWebhookSend("x".repeat(2001), {
        ...webhookOpts,
        onDeliveryResult: ({ messageId }) => {
          progress.push(messageId);
        },
      });
      expect(contents.map((content) => content.length)).toEqual([2000, 1]);
      expect(progress).toEqual(["1", "2"]);
      expect(result.receipt?.platformMessageIds).toEqual(progress);
    });
  });

  it("does not replay an ambiguous binding notification", async () => {
    await withWebhookServer(
      () => ({ status: 503, body: { message: "response lost after commit" } }),
      async (contents) => {
        const record = {
          accountId: "default",
          channelId: "parent-1",
          threadId: "thread-1",
          targetKind: "subagent",
          targetSessionKey: "agent:main:subagent:fixture",
          agentId: "main",
          boundBy: "fixture",
          boundAt: 1,
          lastActivityAt: 1,
          webhookId: "wh-1",
          webhookToken: "synthetic-token",
        } satisfies ThreadBindingRecord;
        await maybeSendBindingMessage({ cfg, record, text: "send once" });
        expect(contents).toEqual(["send once"]);
        expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
      },
    );
  });

  it("retains an accepted chunk without replaying it when a later webhook chunk is rejected", async () => {
    const onDeliveryResult = vi.fn();
    await withWebhookServer(
      (_content, index) =>
        index === 1
          ? { body: { id: "accepted-1", channel_id: "thread-1" } }
          : { status: 404, body: { code: 10015, message: "Unknown Webhook" } },
      async (contents) => {
        await expect(sendBound("x".repeat(2001), cfg, onDeliveryResult)).rejects.toThrow(
          "Unknown Webhook",
        );
        expect(contents.map((content) => content.length)).toEqual([2000, 1]);
        expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            channel: "discord",
            messageId: "accepted-1",
            target: { kind: "channel", id: "thread-1" },
            receipt: expect.objectContaining({ platformMessageIds: ["accepted-1"] }),
          }),
        );
        expect(hoisted.sendMessageDiscordMock).not.toHaveBeenCalled();
      },
    );
  });
});

let makeProxyFetchMock: MockInstance<typeof fetchRuntime.makeProxyFetch>;
let fetchMock: MockInstance<typeof fetch>;

async function expectDeadline() {
  const rejection = expect(realWebhookSend("hello", webhookOpts)).rejects.toMatchObject({
    name: "TimeoutError",
    message: "request timed out",
  });
  await Promise.all([vi.advanceTimersByTimeAsync(DISCORD_REST_TIMEOUT_MS), rejection]);
}

describe("Discord webhook transport", () => {
  beforeEach(() => {
    makeProxyFetchMock = vi.spyOn(fetchRuntime, "makeProxyFetch");
    vi.spyOn(channelActivity, "recordChannelActivity").mockImplementation(() => {});
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "msg-1", channel_id: "thread-1" }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("applies account opt-out of link-preview suppression", async () => {
    await realWebhookSend("https://example.com", {
      ...webhookOpts,
      cfg: {
        channels: {
          discord: { suppressEmbeds: true, accounts: { runtime: { suppressEmbeds: false } } },
        },
      },
      accountId: "runtime",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ content: "https://example.com" }),
    );
  });

  it("uses the configured proxy fetch", async () => {
    const proxiedFetch = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "proxied" }));
    makeProxyFetchMock.mockReturnValue(proxiedFetch);
    await realWebhookSend("hello", {
      ...webhookOpts,
      cfg: { channels: { discord: { proxy: "http://proxy.test:8080" } } },
    });
    expect(makeProxyFetchMock).toHaveBeenCalledWith("http://proxy.test:8080");
    expect(proxiedFetch).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the no-body response when wait is false", async () => {
    const response = new Response(null, { status: 204 });
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValue(response);
    expect((await realWebhookSend("hello", { ...webhookOpts, wait: false })).messageId).toBe("");
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("keeps an accepted send when the response body exceeds the limit", async () => {
    const tracked = cancelTrackedTextResponse(`{"id":"${"x".repeat(16 * 1024 * 1024)}"}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    fetchMock.mockResolvedValue(tracked.response);
    expect((await realWebhookSend("hello", webhookOpts)).messageId).toBe("");
    expect(tracked.wasCanceled()).toBe(true);
  });

  it.each(["rate limit", "pre-connect failure"] as const)(
    "retries a proven %s within its budget and cleans up the deadline",
    async (failure) => {
      if (failure === "rate limit") {
        fetchMock.mockImplementation(async () =>
          Response.json(
            { message: "Slow down", retry_after: 0.75, global: false },
            { status: 429 },
          ),
        );
      } else {
        fetchMock.mockRejectedValueOnce(
          Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
        );
      }
      const sent = realWebhookSend("hello", { ...webhookOpts, threadId: "thread-1" });
      const result =
        failure === "rate limit"
          ? expect(sent).rejects.toMatchObject({
              name: "RateLimitError",
              status: 429,
              retryAfter: 0.75,
            })
          : expect(sent).resolves.toMatchObject({ messageId: "msg-1", channelId: "thread-1" });
      if (failure === "rate limit") {
        await vi.advanceTimersByTimeAsync(749);
        expect(fetchMock).toHaveBeenCalledOnce();
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(failure === "rate limit" ? 3 : 2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds an ambiguous error body without replaying the send", async () => {
    const tracked = cancelTrackedTextResponse(`${"upstream unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchMock.mockResolvedValue(tracked.response);
    const error: unknown = await realWebhookSend("hello", webhookOpts).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(DiscordError);
    if (!(error instanceof DiscordError)) {
      throw error;
    }
    expect(error.status).toBe(503);
    expect(error.message).toContain("upstream unavailable");
    expect(JSON.stringify(error.rawBody)).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts when Discord never returns response headers", async () => {
    fetchMock.mockImplementation((_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      signal.throwIfAborted();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    await expectDeadline();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([200, 503])("keeps the deadline active through a stalled %s body", async (status) => {
    fetchMock.mockImplementation(async (_input, init) => {
      const signal = init?.signal;
      if (!signal) {
        throw new Error("expected webhook request signal");
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        }),
        { status },
      );
    });
    await expectDeadline();
  });

  it("aborts rate-limit backoff at the deadline without leaving a retry timer", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({ message: "Slow down", retry_after: 60 }, { status: 429 }),
    );
    await expectDeadline();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
