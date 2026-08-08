// Ollama production stream UTF-8 rejection over a real loopback HTTP boundary.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createOllamaStreamFn } from "./stream.runtime.js";

const model = {
  api: "ollama",
  provider: "ollama",
  id: "qwen3:32b",
  contextWindow: 131072,
} as never;

const context = {
  messages: [{ role: "user", content: "hello" }],
} as never;

const TERMINAL_NDJSON = [
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":"ok"},"done":false}',
  '{"model":"m","created_at":"t","message":{"role":"assistant","content":""},"done":true}',
].join("\n");

async function withOllamaServer(
  chunks: Uint8Array[],
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const chunk of chunks) {
      response.write(chunk);
    }
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function typeOf(event: unknown): string | undefined {
  return (event as { type?: string } | null | undefined)?.type;
}

describe("ollama production stream UTF-8 rejection over real HTTP", () => {
  it("rejects a partial UTF-8 byte in a later body chunk instead of completing", async () => {
    const terminalChunk = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    await withOllamaServer([terminalChunk, new Uint8Array([0xc3])], async (baseUrl) => {
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(false);
      const errorEvent = events.find((event) => typeOf(event) === "error");
      expect(errorEvent).toBeDefined();
      expect(JSON.stringify(errorEvent)).toMatch(/utf-8/i);
    });
  });

  it("completes successfully for a valid terminal stream", async () => {
    const bytes = new TextEncoder().encode(`${TERMINAL_NDJSON}\n`);
    await withOllamaServer([bytes], async (baseUrl) => {
      const stream = createOllamaStreamFn(baseUrl)(model, context, {});
      const events = await collectStreamEvents(await Promise.resolve(stream));
      expect(events.some((event) => typeOf(event) === "done")).toBe(true);
      expect(events.some((event) => typeOf(event) === "error")).toBe(false);
    });
  });
});
