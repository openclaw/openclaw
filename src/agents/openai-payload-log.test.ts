import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAIPayloadLogger } from "./openai-payload-log.js";

async function waitForJsonlLines(
  filePath: string,
  minLines: number,
): Promise<Array<Record<string, unknown>>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const lines = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.length >= minLines) {
        return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      }
    } catch {
      // keep polling until timeout
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${minLines} lines in ${filePath}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpenAIPayloadLogger", () => {
  it("logs request payloads and usage for openai models", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-payload-log-"));
    const filePath = path.join(dir, "openai-payload.jsonl");
    const logger = createOpenAIPayloadLogger({
      env: {
        OPENCLAW_OPENAI_PAYLOAD_LOG: "1",
        OPENCLAW_OPENAI_PAYLOAD_LOG_FILE: filePath,
      },
      runId: "run-openai",
      sessionId: "session-openai",
      modelApi: "openai-responses",
      provider: "openai",
    });
    expect(logger).not.toBeNull();

    const streamFn = ((
      _model: unknown,
      _context: unknown,
      options?: { onPayload?: (payload: unknown) => void },
    ) => {
      options?.onPayload?.({ input: [{ type: "message", role: "user" }] });
      return null;
    }) as unknown as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    const onPayload = vi.fn<(payload: unknown) => void>();

    await wrapped?.(
      { api: "openai-responses" } as unknown as Model<Api>,
      {} as Parameters<StreamFn>[1],
      { onPayload } as Parameters<StreamFn>[2],
    );

    logger?.recordUsage(
      [
        {
          role: "assistant",
          usage: { input: 123, output: 45 },
        } as unknown as AgentMessage,
      ],
      undefined,
    );

    const lines = await waitForJsonlLines(filePath, 2);
    expect(lines.map((line) => line.stage)).toEqual(["request", "usage"]);
    expect(lines[0]?.payloadDigest).toEqual(expect.any(String));
    expect(lines[1]?.usage).toEqual({ input: 123, output: 45 });
    expect(onPayload).toHaveBeenCalledTimes(1);
  });

  it("does not log non-openai runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openai-payload-log-"));
    const filePath = path.join(dir, "openai-payload.jsonl");
    const logger = createOpenAIPayloadLogger({
      env: {
        OPENCLAW_OPENAI_PAYLOAD_LOG: "true",
        OPENCLAW_OPENAI_PAYLOAD_LOG_FILE: filePath,
      },
      runId: "run-anthropic",
      sessionId: "session-anthropic",
      modelApi: "anthropic-messages",
      provider: "anthropic",
    });
    expect(logger).not.toBeNull();

    const streamFn = ((
      _model: unknown,
      _context: unknown,
      options?: { onPayload?: (payload: unknown) => void },
    ) => {
      options?.onPayload?.({ model: "claude" });
      return null;
    }) as unknown as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.(
      { api: "anthropic-messages" } as unknown as Model<Api>,
      {} as Parameters<StreamFn>[1],
      {} as Parameters<StreamFn>[2],
    );

    logger?.recordUsage(
      [
        {
          role: "assistant",
          usage: { input: 1, output: 2 },
        } as unknown as AgentMessage,
      ],
      undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.readFile(filePath, "utf8")).rejects.toThrow();
  });
});
