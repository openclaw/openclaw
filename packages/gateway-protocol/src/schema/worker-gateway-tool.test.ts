import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { isWorkerTranscriptFrameWithinBudget } from "../worker-transcript-budget.js";
import {
  isWorkerGatewayToolFrameWithinBudget,
  WorkerGatewayToolInvokeParamsSchema,
  WorkerGatewayToolResultSchema,
  type WorkerGatewayToolResult,
} from "./worker-gateway-tool.js";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "./worker-protocol-primitives.js";

describe("worker Gateway tool transport", () => {
  it("rejects a transcript whose image extraction fails", () => {
    const frame = {
      type: "req" as const,
      id: "unreadable",
      method: "worker.transcript.commit" as const,
      toJSON: () => ({}),
      get params(): never {
        throw new Error("unreadable transcript");
      },
    };
    expect(isWorkerTranscriptFrameWithinBudget(frame)).toBe(false);
  });

  it("accepts only a tool invocation bound to the issued surface", () => {
    const request = { generation: "surface", toolId: "tool", toolCallId: "call", arguments: {} };
    expect(Value.Check(WorkerGatewayToolInvokeParamsSchema, request)).toBe(true);
    for (const extra of [
      { sessionId: "other" },
      { method: "config.set" },
      { credential: "other" },
    ]) {
      expect(Value.Check(WorkerGatewayToolInvokeParamsSchema, { ...request, ...extra })).toBe(
        false,
      );
    }
  });

  it("counts encoded control frames and grants the image budget only to image content", () => {
    const frame = (result: WorkerGatewayToolResult) => ({
      type: "res",
      id: "call",
      ok: true,
      payload: result,
    });
    const escaped: WorkerGatewayToolResult = {
      content: [{ type: "text", text: "\u0001".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES / 6) }],
    };
    expect(Value.Check(WorkerGatewayToolResultSchema, escaped)).toBe(true);
    expect(isWorkerGatewayToolFrameWithinBudget(frame(escaped), escaped)).toBe(false);
    const data = "a".repeat(WORKER_PROTOCOL_MAX_PAYLOAD_BYTES);
    const image: WorkerGatewayToolResult = {
      content: [{ type: "image", data, mimeType: "image/png" }],
    };
    expect(isWorkerGatewayToolFrameWithinBudget(frame(image), image)).toBe(true);
    const details: WorkerGatewayToolResult = {
      content: [],
      details: { data },
    };
    expect(isWorkerGatewayToolFrameWithinBudget(frame(details), details)).toBe(false);
    const mixed = { ...details, content: image.content };
    expect(isWorkerGatewayToolFrameWithinBudget(frame(mixed), mixed)).toBe(false);
    const mixedText = { content: [...escaped.content, ...image.content] };
    expect(isWorkerGatewayToolFrameWithinBudget(frame(mixedText), mixedText)).toBe(false);
  });
});
