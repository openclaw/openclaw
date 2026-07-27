import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { startQaOtlpTraceReceiver } from "./otel-trace-receiver.js";

function encodeVarint(input: number): Buffer {
  const bytes: number[] = [];
  let value = input;
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function encodeBytesField(field: number, value: Uint8Array | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return Buffer.concat([encodeVarint(field * 8 + 2), encodeVarint(bytes.length), bytes]);
}

function encodeTraceRequest(names: readonly string[], sensitiveContent?: string): Buffer {
  const encodedSpans = names.map((name) => {
    const parts = [encodeBytesField(5, name)];
    if (sensitiveContent) {
      const encodedValue = encodeBytesField(1, sensitiveContent);
      const encodedAttribute = Buffer.concat([
        encodeBytesField(1, "gen_ai.input.messages"),
        encodeBytesField(2, encodedValue),
      ]);
      parts.push(encodeBytesField(9, encodedAttribute));
    }
    return encodeBytesField(2, Buffer.concat(parts));
  });
  const scopeSpans = Buffer.concat(encodedSpans);
  const resourceSpans = encodeBytesField(2, scopeSpans);
  return encodeBytesField(1, resourceSpans);
}

describe("QA OTLP trace receiver", () => {
  it("decodes real OTLP protobuf trace spans instead of treating exporter logs as traces", async () => {
    const receiver = await startQaOtlpTraceReceiver({
      disallowedNeedles: ["OTEL-QA-SECRET"],
    });
    try {
      const response = await fetch(`${receiver.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: encodeTraceRequest(["openclaw.run", "openclaw.harness.run"]),
      });

      expect(response.status).toBe(200);
      expect(receiver.spans).toStrictEqual([
        { name: "openclaw.run" },
        { name: "openclaw.harness.run" },
      ]);
      expect(receiver.requests).toStrictEqual([{ path: "/v1/traces", status: 200, spanCount: 2 }]);
      expect(receiver.leakedNeedles.size).toBe(0);
    } finally {
      await receiver.close();
    }
  });

  it("decodes compressed protobuf traces from the actual OTLP exporter", async () => {
    const receiver = await startQaOtlpTraceReceiver();
    try {
      const response = await fetch(`${receiver.endpoint}/v1/traces`, {
        method: "POST",
        headers: {
          "content-type": "application/x-protobuf",
          "content-encoding": "gzip",
        },
        body: gzipSync(encodeTraceRequest(["openclaw.run"])),
      });

      expect(response.status).toBe(200);
      expect(receiver.spans).toStrictEqual([{ name: "openclaw.run" }]);
    } finally {
      await receiver.close();
    }
  });

  it("rejects malformed and empty traces without manufacturing span evidence", async () => {
    const receiver = await startQaOtlpTraceReceiver();
    try {
      for (const body of [Buffer.from([0x0a, 0xff]), Buffer.alloc(0)]) {
        const response = await fetch(`${receiver.endpoint}/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body,
        });
        expect(response.status).toBe(400);
      }

      expect(receiver.spans).toStrictEqual([]);
      expect(receiver.requests).toStrictEqual([
        { path: "/v1/traces", status: 400, spanCount: 0 },
        { path: "/v1/traces", status: 400, spanCount: 0 },
      ]);
    } finally {
      await receiver.close();
    }
  });

  it("detects secret prompt content in the actual decoded trace request", async () => {
    const receiver = await startQaOtlpTraceReceiver({
      disallowedNeedles: ["OTEL-QA-SECRET"],
    });
    try {
      const response = await fetch(`${receiver.endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf" },
        body: encodeTraceRequest(["openclaw.run"], "OTEL-QA-SECRET"),
      });

      expect(response.status).toBe(200);
      expect(receiver.spans).toStrictEqual([{ name: "openclaw.run" }]);
      expect([...receiver.leakedNeedles]).toStrictEqual(["OTEL-QA-SECRET"]);
    } finally {
      await receiver.close();
    }
  });

  it("never counts metric or log exporter requests as trace evidence", async () => {
    const receiver = await startQaOtlpTraceReceiver();
    try {
      for (const signal of ["metrics", "logs"]) {
        const response = await fetch(`${receiver.endpoint}/v1/${signal}`, {
          method: "POST",
          headers: { "content-type": "application/x-protobuf" },
          body: Buffer.from([0x0a, 0x00]),
        });
        expect(response.status).toBe(200);
      }

      expect(receiver.spans).toStrictEqual([]);
      expect(receiver.requests.every((request) => request.spanCount === 0)).toBe(true);
    } finally {
      await receiver.close();
    }
  });
});
