import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

async function waitForFileContains(filePath: string, text: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      if (content.includes(text)) {
        return;
      }
    } catch {
      // File creation is asynchronous in the queued writer.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath} to contain ${text}`);
}

describe("createAnthropicPayloadLogger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays disabled by default", () => {
    expect(createAnthropicPayloadLogger({ env: {} })).toBeNull();
  });

  it("redacts structured secrets before writing payload logs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-log-"));
    const logFile = path.join(tmpDir, "anthropic-payload.jsonl");
    const logger = createAnthropicPayloadLogger({
      env: {
        ...process.env,
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1",
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE: logFile,
      },
    });

    expect(logger).not.toBeNull();

    const streamFn = vi.fn(
      (_model, _context, options?: { onPayload?: (payload: unknown) => void }) => {
        options?.onPayload?.({
          messages: [
            {
              role: "user",
              content: "voice note says OPENAI_API_KEY=sk-1234567890abcdef and keep this sentence",
            },
          ],
        });
        return Promise.resolve(undefined);
      },
    );

    await logger!.wrapStreamFn(streamFn as never)(
      { api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    await waitForFileContains(logFile, "OPENAI_API_KEY=sk-123…cdef");

    const raw = await fs.readFile(logFile, "utf8");
    expect(raw).toContain("keep this sentence");
    expect(raw).not.toContain("OPENAI_API_KEY=sk-1234567890abcdef");
  });

  it("redacts base64 image data from payload before logging", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-log-"));
    const logFile = path.join(tmpDir, "anthropic-payload.jsonl");
    const logger = createAnthropicPayloadLogger({
      env: {
        ...process.env,
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1",
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE: logFile,
      },
    });

    expect(logger).not.toBeNull();

    // Simulate a realistic base64-encoded image payload (non-trivial length).
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ".repeat(50);
    const streamFn = vi.fn(
      (_model, _context, options?: { onPayload?: (payload: unknown) => void }) => {
        options?.onPayload?.({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: imageData,
                  },
                },
              ],
            },
          ],
        });
        return Promise.resolve(undefined);
      },
    );

    await logger!.wrapStreamFn(streamFn as never)(
      { api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    await waitForFileContains(logFile, "<redacted:");

    const raw = await fs.readFile(logFile, "utf8");
    expect(raw).not.toContain(imageData);
    expect(raw).toContain("<redacted:");
    expect(raw).toContain("image/png");
  });

  it("computes payloadDigest from the sanitized payload that is logged", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-payload-log-"));
    const logFile = path.join(tmpDir, "anthropic-payload.jsonl");
    const logger = createAnthropicPayloadLogger({
      env: {
        ...process.env,
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1",
        OPENCLAW_ANTHROPIC_PAYLOAD_LOG_FILE: logFile,
      },
    });

    expect(logger).not.toBeNull();

    const rawPayload = {
      messages: [
        {
          role: "user",
          content: "token=sk-1234567890abcdef",
        },
      ],
    };

    const streamFn = vi.fn(
      (_model, _context, options?: { onPayload?: (payload: unknown) => void }) => {
        options?.onPayload?.(rawPayload);
        return Promise.resolve(undefined);
      },
    );

    await logger!.wrapStreamFn(streamFn as never)(
      { api: "anthropic-messages" } as never,
      {} as never,
      {},
    );

    await waitForFileContains(logFile, '"payloadDigest"');

    const raw = await fs.readFile(logFile, "utf8");
    const line = raw
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    expect(line).toBeDefined();
    const event = JSON.parse(line!) as { payload?: unknown; payloadDigest?: string };
    const expectedDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(event.payload))
      .digest("hex");
    const rawDigest = crypto.createHash("sha256").update(JSON.stringify(rawPayload)).digest("hex");

    expect(event.payloadDigest).toBe(expectedDigest);
    expect(event.payloadDigest).not.toBe(rawDigest);
  });
});
