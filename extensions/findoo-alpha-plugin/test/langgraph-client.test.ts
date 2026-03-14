import { describe, expect, it, vi, beforeEach } from "vitest";
import { LangGraphClient } from "../src/langgraph-client.js";

describe("LangGraphClient", () => {
  let client: LangGraphClient;

  beforeEach(() => {
    client = new LangGraphClient("http://localhost:5085", "test-assistant-id");
    vi.restoreAllMocks();
  });

  describe("healthCheck", () => {
    it("returns true on 200", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 200 }));
      expect(await client.healthCheck()).toBe(true);
    });

    it("returns false on non-200", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 503 }));
      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe("createThread", () => {
    it("sends POST /threads and returns thread_id", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(JSON.stringify({ thread_id: "thread-abc" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const result = await client.createThread({ purpose: "test" });

      expect(result.thread_id).toBe("thread-abc");
      expect(fetchSpy).toHaveBeenCalledOnce();
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:5085/threads");
      expect(opts?.method).toBe("POST");
      const body = JSON.parse(opts?.body as string);
      expect(body.metadata).toEqual({ purpose: "test" });
    });

    it("sends empty body when no metadata", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({ thread_id: "t-1" }), { status: 200 }));

      await client.createThread();
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body).toEqual({});
    });

    it("throws on non-200 after retries exhausted", async () => {
      const spy = vi.spyOn(globalThis, "fetch");
      // createThread retries 2x on 5xx, so mock 3 total failures (1 original + 2 retries)
      for (let i = 0; i < 3; i++) {
        spy.mockResolvedValueOnce(
          new Response("Error", { status: 500, statusText: "Internal Server Error" }),
        );
      }
      await expect(client.createThread()).rejects.toThrow("LangGraph createThread failed: 500");
      expect(spy).toHaveBeenCalledTimes(3);
    });
  });

  describe("createStreamingRun", () => {
    it("sends POST /threads/{id}/runs/stream with correct body", async () => {
      const mockBody = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(mockBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );

      const resp = await client.createStreamingRun(
        "thread-abc",
        [{ role: "user", content: "分析茅台" }],
        { symbols: ["600519.SS"] },
      );

      expect(resp.ok).toBe(true);
      const [url, opts] = fetchSpy.mock.calls[0];
      expect(url).toBe("http://localhost:5085/threads/thread-abc/runs/stream");
      expect(opts?.method).toBe("POST");
      expect(opts?.headers).toEqual({
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      });

      const body = JSON.parse(opts?.body as string);
      expect(body.assistant_id).toBe("test-assistant-id");
      expect(body.input.messages).toEqual([{ role: "user", content: "分析茅台" }]);
      expect(body.input.context).toEqual({ symbols: ["600519.SS"] });
      expect(body.stream_mode).toBe("updates");
    });

    it("omits context when not provided", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          { status: 200 },
        ),
      );

      await client.createStreamingRun("t-1", [{ role: "user", content: "hi" }]);
      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.input.context).toBeUndefined();
    });

    it("throws on non-200", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("Error", { status: 404, statusText: "Not Found" }),
      );
      await expect(
        client.createStreamingRun("t-1", [{ role: "user", content: "hi" }]),
      ).rejects.toThrow("LangGraph streaming run failed: 404");
    });
  });

  describe("getThreadState", () => {
    it("sends GET /threads/{id}/state", async () => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ values: { messages: [] } }), { status: 200 }),
        );

      const state = await client.getThreadState("thread-abc");
      expect(state).toEqual({ values: { messages: [] } });
      expect(fetchSpy.mock.calls[0][0]).toBe("http://localhost:5085/threads/thread-abc/state");
    });
  });

  describe("parseSSE", () => {
    function makeStream(text: string): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
    }

    it("parses single event", async () => {
      const stream = makeStream('event: updates\ndata: {"node":"analyzer","output":"hello"}\n\n');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      for await (const e of LangGraphClient.parseSSE(stream)) {
        events.push(e);
      }
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("updates");
      expect(events[0].data).toEqual({ node: "analyzer", output: "hello" });
    });

    it("parses multiple events", async () => {
      const text = [
        "event: updates",
        'data: {"node":"a","output":"step1"}',
        "",
        "event: updates",
        'data: {"node":"b","output":"step2"}',
        "",
        "event: end",
        "data: {}",
        "",
      ].join("\n");

      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      for await (const e of LangGraphClient.parseSSE(makeStream(text))) {
        events.push(e);
      }
      expect(events).toHaveLength(3);
      expect(events[0].data).toEqual({ node: "a", output: "step1" });
      expect(events[1].data).toEqual({ node: "b", output: "step2" });
      expect(events[2].event).toBe("end");
    });

    it("skips SSE comments", async () => {
      const stream = makeStream(':comment\nevent: updates\ndata: {"ok":true}\n\n');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      for await (const e of LangGraphClient.parseSSE(stream)) {
        events.push(e);
      }
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual({ ok: true });
    });

    it("handles malformed JSON gracefully", async () => {
      const stream = makeStream("event: updates\ndata: not-json\n\nevent: end\ndata: {}\n\n");
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      for await (const e of LangGraphClient.parseSSE(stream)) {
        events.push(e);
      }
      // Malformed event skipped, only "end" event parsed
      expect(events).toHaveLength(1);
      expect(events[0].event).toBe("end");
    });

    it("uses 'message' as default event name", async () => {
      const stream = makeStream('data: {"hello":true}\n\n');
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      for await (const e of LangGraphClient.parseSSE(stream)) {
        events.push(e);
      }
      expect(events[0].event).toBe("message");
    });
  });
});
