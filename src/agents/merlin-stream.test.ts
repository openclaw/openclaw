import { describe, expect, it } from "vitest";
import { parseSseStream } from "./merlin-stream.js";

function createReadableStream(text: string): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return stream.getReader();
}

describe("merlin-stream", () => {
  describe("parseSseStream", () => {
    it("should parse a simple text message event", async () => {
      const sseText =
        'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":"hello"}}\n\n' +
        'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}\n\n';

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe("message");
      const parsed = JSON.parse(events[0]?.data ?? "{}") as {
        data?: { type?: string; text?: string };
      };
      expect(parsed.data?.type).toBe("text");
      expect(parsed.data?.text).toBe("hello");
    });

    it("should parse multiple streaming chunks", async () => {
      const sseText =
        'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":"hello "}}\n\n' +
        'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":"world"}}\n\n' +
        'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}\n\n';

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);

      const chunk1 = JSON.parse(events[0]?.data ?? "{}") as {
        data?: { text?: string };
      };
      const chunk2 = JSON.parse(events[1]?.data ?? "{}") as {
        data?: { text?: string };
      };
      expect(chunk1.data?.text).toBe("hello ");
      expect(chunk2.data?.text).toBe("world");
    });

    it("should parse error events", async () => {
      const sseText =
        'event: error\ndata: {"message":"There was an internal error.","type":"INTERNAL_SERVER_ERROR"}\n\n' +
        'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}\n\n';

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe("error");
      const errData = JSON.parse(events[0]?.data ?? "{}") as { message?: string };
      expect(errData.message).toBe("There was an internal error.");
    });

    it("should parse reasoning events", async () => {
      const sseText =
        'event: message\ndata: {"data":{"content":"","index":1,"type":"reasoning","reasoning":"thinking..."}}\n\n' +
        'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":"answer"}}\n\n' +
        'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}\n\n';

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(3);
      const reasoning = JSON.parse(events[0]?.data ?? "{}") as {
        data?: { type?: string; reasoning?: string };
      };
      expect(reasoning.data?.type).toBe("reasoning");
      expect(reasoning.data?.reasoning).toBe("thinking...");
    });

    it("should parse usage events", async () => {
      const sseText =
        'event: usage\ndata: {"cost":{"dailyUsage":{"usage":0.5,"limit":16}},"userPlan":"SUMO_2"}\n\n' +
        'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}\n\n';

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
      expect(events[0]?.event).toBe("usage");
      const usage = JSON.parse(events[0]?.data ?? "{}") as {
        userPlan?: string;
      };
      expect(usage.userPlan).toBe("SUMO_2");
    });

    it("should handle a full realistic SSE stream", async () => {
      const sseText =
        [
          'event: progress\ndata: {"payload":{"name":"Flow","icon":"LIGHTBULB"},"metadata":{"type":"HEADING"}}',
          'event: chatTitle\ndata: {"title":"Hello World"}',
          'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":"Hello"}}',
          'event: message\ndata: {"data":{"content":"","index":1,"type":"text","text":" World!"}}',
          'event: attachments\ndata: {"payload":[]}',
          'event: references\ndata: {"payload":[]}',
          'event: usage\ndata: {"cost":{"dailyUsage":{"usage":0.1,"limit":16}},"userPlan":"SUMO_2"}',
          'event: message\ndata: {"status":"system","data":{"content":" ","eventType":"DONE"}}',
        ].join("\n\n") + "\n\n";

      const reader = createReadableStream(sseText);
      const events: { event: string; data: string }[] = [];
      for await (const event of parseSseStream(reader)) {
        events.push(event);
      }

      expect(events).toHaveLength(8);
      expect(events.map((e) => e.event)).toEqual([
        "progress",
        "chatTitle",
        "message",
        "message",
        "attachments",
        "references",
        "usage",
        "message",
      ]);
    });
  });
});
