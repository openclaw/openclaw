import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureUrbitChannelOpen } from "./channel-ops.js";
import { urbitFetch } from "./fetch.js";
import { UrbitSSEClient } from "./sse-client.js";
vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));
vi.mock("./channel-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-ops.js")>()),
  ensureUrbitChannelOpen: vi.fn().mockResolvedValue(undefined),
  pokeUrbitChannel: vi.fn().mockResolvedValue(undefined),
  scryUrbitPath: vi.fn().mockResolvedValue({}),
}));
function guardedResponse(response = new Response(null, { status: 200 })) {
  return {
    response,
    finalUrl: "https://example.com",
    release: vi.fn().mockResolvedValue(undefined),
  };
}
async function* stopAfterStream(client: UrbitSSEClient, stream: AsyncIterable<string | Buffer>) {
  try {
    yield* stream;
  } finally {
    client.stopReceiving();
  }
}
describe("UrbitSSEClient", () => {
  let client: UrbitSSEClient;
  let handler: ReturnType<typeof vi.fn<(data: unknown) => void | Promise<void>>>;
  const mockUrbitFetch = vi.mocked(urbitFetch);
  beforeEach(() => {
    vi.clearAllMocks();
    client = new UrbitSSEClient("https://example.com", "urbauth-~zod=123");
    handler = vi.fn();
  });
  function consume(stream: AsyncIterable<string | Buffer>) {
    client.eventHandlers.set(1, { event: handler });
    return client.processStream(stopAfterStream(client, stream));
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("releases the stream guard after a handler error", async () => {
    const guarded = guardedResponse(new Response('data: {"json":{"ok":true}}\n\n'));
    vi.mocked(urbitFetch).mockResolvedValueOnce(guarded);
    const processing = vi.spyOn(client, "processStream");
    vi.spyOn(client, "attemptReconnect").mockResolvedValue(undefined);
    await client.subscribe({
      app: "chat",
      path: "/inbox",
      event: () => {
        throw new Error("handler failed");
      },
    });
    await client.openStream();
    await expect(processing.mock.results[0]?.value).rejects.toThrow("handler failed");
    expect(guarded.release).toHaveBeenCalledOnce();
    expect(client.streamRelease).toBeNull();
  });
  describe("reconnection", () => {
    it("replaces a server-deleted HTTP channel and restores subscriptions", async () => {
      vi.useFakeTimers();
      mockUrbitFetch
        .mockResolvedValueOnce(guardedResponse(new Response(null, { status: 404 })))
        .mockResolvedValueOnce(guardedResponse());
      await client.subscribe({ app: "chat", path: "/dm/~zod", event: () => {} });
      const deletedChannelId = client.channelId;
      const reconnecting = client.attemptReconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      await reconnecting;
      expect(client.channelId).not.toBe(deletedChannelId);
      expect(ensureUrbitChannelOpen).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: client.channelId }),
        expect.objectContaining({ createBody: client.subscriptions }),
      );
      expect(mockUrbitFetch).toHaveBeenCalledTimes(2);
      expect(mockUrbitFetch.mock.calls[1]?.[0].path).toBe(`/~/channel/${client.channelId}`);
      expect(client.reconnectAttempts).toBe(0);
    });
  });
  describe("event acking", () => {
    it("logs malformed SSE JSON with an owned parser error", async () => {
      const logger = { error: vi.fn() };
      client.logger = logger;
      await client.processEvent("id: 1\ndata: {not json");
      expect(logger.error).toHaveBeenCalledWith(
        "Error parsing SSE event: Error: Tlon Urbit SSE event was malformed JSON",
      );
    });
    it("guards JSON.parse against oversized SSE payload to prevent OOM", async () => {
      const errors: string[] = [];
      client.logger = { error: (msg) => errors.push(msg) };
      const hugeJson = '{"json":{"ok":true,"x":"' + "A".repeat(16 * 1024 * 1024) + '"}}';
      await client.processEvent(`id: 1\ndata: ${hugeJson}`);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(
        "Error parsing SSE event: Error: Tlon Urbit SSE payload exceeds 16 MiB limit",
      );
    });
    describe("stream buffer bounding", () => {
      it("rejects oversized stream buffer before unbounded accumulation", async () => {
        const chunk = "x".repeat(1024 * 1024);
        const stream = Readable.from(Array.from({ length: 17 }, () => chunk));
        await expect(consume(stream)).rejects.toThrow(
          "Tlon Urbit SSE stream buffer exceeded 16 MiB limit",
        );
      });
      it("drains a cross-chunk event boundary before retaining the next event", async () => {
        const cap = 16 * 1024 * 1024;
        const prefix = 'id: 1\ndata: {"json":{"value":"';
        const suffix = '"}}\n';
        const padLen = cap - Buffer.byteLength(prefix + suffix, "utf8") - 128;
        const nextValue = "b".repeat(256);
        const firstChunk = prefix + "a".repeat(padLen) + suffix;
        const secondChunk = `\nid: 1\ndata: {"json":{"value":"${nextValue}"}}\n\n`;
        expect(Buffer.byteLength(firstChunk + secondChunk, "utf8")).toBeGreaterThan(cap);
        const stream = Readable.from([firstChunk, secondChunk]);
        await consume(stream);
        expect(handler).toHaveBeenCalledTimes(2);
        expect((handler.mock.calls[0]?.[0] as { value?: string } | undefined)?.value).toHaveLength(
          padLen,
        );
        expect(handler.mock.calls[1]?.[0]).toEqual({ value: nextValue });
      });
      it("preserves split UTF-8 code points and split event delimiters", async () => {
        const encoded = Buffer.from('id: 1\ndata: {"json":{"text":"😀"}}\n\n');
        const emojiStart = encoded.indexOf(Buffer.from("😀"));
        const stream = Readable.from([
          encoded.subarray(0, emojiStart + 2),
          encoded.subarray(emojiStart + 2, -1),
          encoded.subarray(-1),
        ]);
        await consume(stream);
        expect(handler).toHaveBeenCalledWith({ text: "😀" });
      });
      it.each([
        {
          ending: "CRLF",
          chunks: ["id:1\r", '\ndata:{"id":1,"json":{"text":"split"}}\r', "\n\r", "\n"],
        },
      ])("preserves $ending delimiters split across byte chunks", async ({ chunks }) => {
        await client.subscribe({ app: "chat", path: "/inbox", event: handler });
        const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
        await client.processStream(stopAfterStream(client, stream));
        expect(handler.mock.calls).toEqual([[{ text: "split" }]]);
      });
      it("accepts a boundary-sized event with split surrogate pair and delimiter", async () => {
        const cap = 16 * 1024 * 1024;
        const prefix = 'id: 1\ndata: {"json":{"text":"';
        const suffix = '"}}';
        const padLen = cap - Buffer.byteLength(prefix + "😀" + suffix, "utf8");
        const stream = Readable.from([
          prefix + "a".repeat(padLen) + "\uD83D",
          `\uDE00${suffix}\n`,
          "\n",
        ]);
        await consume(stream);
        const payload = handler.mock.calls[0]?.[0] as { text?: string } | undefined;
        expect(payload?.text).toHaveLength(padLen + 2);
        expect(payload?.text?.endsWith("😀")).toBe(true);
      });
    });
    it("ignores malformed event ids when deciding whether to ack", async () => {
      mockUrbitFetch.mockResolvedValue(guardedResponse());
      await client.processEvent('id: 25abc\ndata: {"json":{"ok":true}}');
      expect(mockUrbitFetch).not.toHaveBeenCalled();
      expect((client as unknown as { lastHeardEventId: number }).lastHeardEventId).toBe(-1);
    });
    it("waits for durable admission before acknowledging the transport event", async () => {
      mockUrbitFetch.mockResolvedValue(guardedResponse());
      const admission = Promise.withResolvers<void>();
      handler.mockImplementation(() => admission.promise);
      client.eventHandlers.set(1, { event: handler });
      const processing = client.processEvent('id: 20\ndata: {"id":1,"json":{"ok":true}}');
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      expect(mockUrbitFetch).not.toHaveBeenCalled();
      admission.resolve();
      await processing;
      expect(mockUrbitFetch).toHaveBeenCalledTimes(1);
      const body = mockUrbitFetch.mock.calls[0]?.[0].init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected string ACK request body");
      }
      expect(JSON.parse(body)).toEqual([{ id: expect.any(Number), action: "ack", "event-id": 20 }]);
    });
    it("does not acknowledge a failed durable admission", async () => {
      client.eventHandlers.set(1, {
        event: async () => {
          throw new Error("sqlite unavailable");
        },
      });
      await expect(
        client.processEvent('id: 20\ndata: {"id":1,"json":{"ok":true}}'),
      ).rejects.toThrow("sqlite unavailable");
      expect(mockUrbitFetch).not.toHaveBeenCalled();
    });
    it("retries a failed ack when the unacknowledged event replays", async () => {
      mockUrbitFetch.mockResolvedValue(guardedResponse(new Response(null, { status: 204 })));
      client.eventHandlers.set(1, { event: handler });
      // A success stub makes an eager ACK fail at the no-call assertion, not in transport.
      await client.processEvent('id: 1\ndata: {"id":1,"json":{"ok":true}}');
      expect(mockUrbitFetch).not.toHaveBeenCalled();
      mockUrbitFetch.mockResolvedValueOnce(guardedResponse(new Response(null, { status: 503 })));
      const event = 'id: 20\ndata: {"id":1,"json":{"ok":true}}';
      await expect(client.processEvent(event)).rejects.toThrow("Ack failed with status 503");
      expect(
        (client as unknown as { lastAcknowledgedEventId: number }).lastAcknowledgedEventId,
      ).toBe(-1);
      await expect(client.processEvent(event)).resolves.toBeUndefined();
      expect(mockUrbitFetch).toHaveBeenCalledTimes(2);
      expect(
        (client as unknown as { lastAcknowledgedEventId: number }).lastAcknowledgedEventId,
      ).toBe(20);
    });
  });
  it("backs off through ten attempts before the cooldown resets the schedule", async () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn(() => {
      throw new Error("authentication unavailable");
    });
    const logger = { log: vi.fn() };
    client.onReconnect = onReconnect;
    client.logger = logger;
    const reconnect = client.attemptReconnect();
    try {
      const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000];
      for (const [attempt, delay] of delays.entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(onReconnect).toHaveBeenCalledTimes(attempt);
        await vi.advanceTimersByTimeAsync(1);
        expect(onReconnect).toHaveBeenCalledTimes(attempt + 1);
      }
      expect(logger.log).toHaveBeenCalledWith(
        "[SSE] Max reconnection attempts (10) reached. Waiting 10s before resetting...",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(onReconnect).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(999);
      expect(onReconnect).toHaveBeenCalledTimes(10);
      await vi.advanceTimersByTimeAsync(1);
      expect(onReconnect).toHaveBeenCalledTimes(11);
    } finally {
      client.stopReceiving();
      await reconnect;
    }
  });
});
