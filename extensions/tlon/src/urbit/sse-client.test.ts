import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { urbitFetch } from "./fetch.js";
import { UrbitSSEClient } from "./sse-client.js";
vi.mock("./fetch.js", () => ({
  urbitFetch: vi.fn(),
}));
function guardedResponse(response = new Response(null, { status: 200 })) {
  return {
    response,
    finalUrl: "https://example.com",
    release: vi.fn().mockResolvedValue(undefined),
  };
}
const CAP = 16 * 1024 * 1024;
const frame = (key: string, value: string) =>
  `id: 1\ndata: ${JSON.stringify({ json: { [key]: value } })}`;
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
    client.eventHandlers.set(1, { event: handler });
  });
  function consume(...chunks: Array<string | Buffer>) {
    return client.processStream(stopAfterStream(client, Readable.from(chunks)));
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
  describe("event acking", () => {
    it.each([
      ["malformed", "Tlon Urbit SSE event was malformed JSON"],
      ["oversized", "Tlon Urbit SSE payload exceeds 16 MiB limit"],
    ])("logs rejected %s SSE JSON", async (kind, message) => {
      const json =
        kind === "malformed"
          ? "{not json"
          : '{"json":{"ok":true,"x":"' + "A".repeat(16 * 1024 * 1024) + '"}}';
      const logger = { error: vi.fn() };
      client.logger = logger;
      await client.processEvent(`id: 1\ndata: ${json}`);
      expect(logger.error.mock.calls).toEqual([[`Error parsing SSE event: Error: ${message}`]]);
    });
    describe("stream buffer bounding", () => {
      it("rejects oversized stream buffer before unbounded accumulation", async () => {
        const chunk = "x".repeat(1024 * 1024);
        await expect(consume(...Array.from({ length: 17 }, () => chunk))).rejects.toThrow(
          "Tlon Urbit SSE stream buffer exceeded 16 MiB limit",
        );
      });
      it("drains a cross-chunk event boundary before retaining the next event", async () => {
        const padLen = CAP - Buffer.byteLength(frame("value", "") + "\n", "utf8") - 128;
        const nextValue = "b".repeat(256);
        const firstChunk = frame("value", "a".repeat(padLen)) + "\n";
        const secondChunk = `\n${frame("value", nextValue)}\n\n`;
        expect(Buffer.byteLength(firstChunk + secondChunk, "utf8")).toBeGreaterThan(CAP);
        await consume(firstChunk, secondChunk);
        expect(handler).toHaveBeenCalledTimes(2);
        expect((handler.mock.calls[0]?.[0] as { value?: string } | undefined)?.value).toHaveLength(
          padLen,
        );
        expect(handler.mock.calls[1]?.[0]).toEqual({ value: nextValue });
      });
      it("preserves split UTF-8 code points and split event delimiters", async () => {
        const encoded = Buffer.from('id: 1\ndata: {"json":{"text":"😀"}}\n\n');
        const emojiStart = encoded.indexOf(Buffer.from("😀"));
        await consume(
          encoded.subarray(0, emojiStart + 2),
          encoded.subarray(emojiStart + 2, -1),
          encoded.subarray(-1),
        );
        expect(handler).toHaveBeenCalledWith({ text: "😀" });
      });
      it("preserves CRLF delimiters split across byte chunks", async () => {
        const chunks = ["id:1\r", '\ndata:{"id":1,"json":{"text":"split"}}\r', "\n\r", "\n"];
        await client.subscribe({ app: "chat", path: "/inbox", event: handler });
        const stream = Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
        await client.processStream(stopAfterStream(client, stream));
        expect(handler.mock.calls).toEqual([[{ text: "split" }]]);
      });
      it("accepts a boundary-sized event with split surrogate pair and delimiter", async () => {
        const padLen = CAP - Buffer.byteLength(frame("text", "😀"), "utf8");
        const event = frame("text", "a".repeat(padLen) + "😀");
        const split = event.indexOf("😀") + 1;
        await consume(event.slice(0, split), event.slice(split) + "\n", "\n");
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
  describe("stall detection", () => {
    // An open stream whose peer vanished: bytes stop and the body never ends.
    function silentAfter(...chunks: string[]) {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
        },
      });
    }

    async function openSilentStream(...chunks: string[]) {
      const guarded = guardedResponse(new Response(silentAfter(...chunks)));
      mockUrbitFetch.mockResolvedValueOnce(guarded);
      const reconnect = vi.spyOn(client, "attemptReconnect").mockResolvedValue(undefined);
      const processing = vi.spyOn(client, "processStream");
      await client.openStream();
      const done = processing.mock.results[0]?.value as Promise<void>;
      done.catch(() => {});
      return { guarded, reconnect, done };
    }

    it("ends a stream that stops delivering heartbeats", async () => {
      vi.useFakeTimers();
      const { guarded, reconnect, done } = await openSilentStream(
        'id: 1\ndata: {"id":1,"json":{"ok":true}}\n\n',
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledWith({ ok: true });

      await vi.advanceTimersByTimeAsync(55_000);
      expect(reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(reconnect).toHaveBeenCalledOnce();
      await expect(done).rejects.toThrow("Tlon Urbit SSE stream stalled");
      expect(guarded.release).toHaveBeenCalledOnce();
      expect(client.isConnected).toBe(false);
    });

    it("keeps a stream open while Eyre heartbeats arrive", async () => {
      vi.useFakeTimers();
      let push: ((chunk: string) => void) | undefined;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (chunk) => controller.enqueue(encoder.encode(chunk));
        },
      });
      mockUrbitFetch.mockResolvedValueOnce(guardedResponse(new Response(body)));
      const reconnect = vi.spyOn(client, "attemptReconnect").mockResolvedValue(undefined);
      await client.openStream();
      for (let beat = 0; beat < 9; beat += 1) {
        await vi.advanceTimersByTimeAsync(20_000);
        push?.(":\n");
      }
      expect(reconnect).not.toHaveBeenCalled();
      client.stopReceiving();
    });

    it("does not count slow event handling as a stall", async () => {
      vi.useFakeTimers();
      handler.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(resolve, 90_000);
          }),
      );
      const { reconnect } = await openSilentStream('data: {"json":{"ok":true}}\n\n');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(handler).toHaveBeenCalledOnce();
      expect(reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(65_000);
      expect(reconnect).toHaveBeenCalledOnce();
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
