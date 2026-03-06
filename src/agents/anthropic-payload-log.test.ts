import crypto from "node:crypto";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("redacts image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
    };
    const streamFn: StreamFn = ((_, __, options) => {
      options?.onPayload?.(payload);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const message = ((event.payload as { messages?: unknown[] } | undefined)?.messages ??
      []) as Array<Record<string, unknown>>;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toBeDefined();
  });

  it("returns null when payload logging is disabled", () => {
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "0" },
    });
    expect(logger).toBeNull();
  });

  it("does not log when OPENCLAW_ANTHROPIC_PAYLOAD_LOG is not set", () => {
    const logger = createAnthropicPayloadLogger({ env: {} });
    expect(logger).toBeNull();
  });

  it("passes through calls for non-Anthropic models without logging", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const streamFn: StreamFn = ((_, __, options) => {
      options?.onPayload?.({ type: "request" });
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "openai" } as never, { messages: [] } as never, {});

    expect(lines).toHaveLength(0);
  });

  it("recordUsage does not write when there is no assistant message and no error", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    logger?.recordUsage([] as AgentMessage[]);
    expect(lines).toHaveLength(0);
  });

  it("recordUsage writes error line when error is provided but no assistant message", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    logger?.recordUsage([] as AgentMessage[], new Error("quota exceeded"));

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect(event.error).toBe("quota exceeded");
  });

  it("recordUsage writes usage fields from the last assistant message", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });

    const messages = [
      { role: "assistant", usage: { input_tokens: 10, output_tokens: 5 } },
    ] as unknown as AgentMessage[];

    logger?.recordUsage(messages);

    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("usage");
    expect((event.usage as { input_tokens?: number } | undefined)?.input_tokens).toBe(10);
  });
});
