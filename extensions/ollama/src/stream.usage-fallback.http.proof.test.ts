// Real-socket proof for Ollama CJK usage fallback when eval counts are absent.
// Drives createOllamaStreamFn through fetchWithSsrFGuard against a loopback
// node:http server that speaks Ollama NDJSON and omits prompt_eval_count /
// eval_count on the final chunk — the production fallback trigger.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { estimateStringChars } from "./cjk-char-estimate.js";
import { createOllamaStreamFn } from "./stream.js";

async function listenLocal(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function writeNdjson(res: ServerResponse, chunks: Array<Record<string, unknown>>): void {
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const chunk of chunks) {
    res.write(`${JSON.stringify(chunk)}\n`);
  }
  res.end();
}

describe("createOllamaStreamFn CJK usage fallback (real HTTP)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it("estimates CJK-aware usage when a real Ollama-shaped stream omits eval counts", async () => {
    const cjkPrompt = "这是一个测试用的句子呢";
    const cjkCompletion = "你好世界测试";
    const naivePromptEstimate = Math.round((cjkPrompt.length + "[]".length) / 4);
    const naiveCompletionEstimate = Math.round(cjkCompletion.length / 4);
    const expectedInput = Math.max(
      1,
      Math.round((estimateStringChars(cjkPrompt) + estimateStringChars("[]")) / 4),
    );
    const expectedOutput = Math.max(1, Math.round(estimateStringChars(cjkCompletion) / 4));

    let seenPath = "";
    let seenBody = "";
    server = createServer((req, res) => {
      void (async () => {
        seenPath = req.url ?? "";
        seenBody = await readRequestBody(req);
        writeNdjson(res, [
          {
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: cjkCompletion },
            done: false,
          },
          {
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:01Z",
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            // Real Ollama usually includes eval counts; omitting them forces
            // the production fallback path under test.
          },
        ]);
      })().catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });

    const port = await listenLocal(server);
    const baseUrl = `http://127.0.0.1:${port}`;
    const streamFn = createOllamaStreamFn(baseUrl);
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      { messages: [{ role: "user", content: cjkPrompt }] } as never,
      {},
    );

    const events: Array<{
      type: string;
      message?: { usage?: { input?: number; output?: number } };
    }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      message?: { usage?: { input?: number; output?: number } };
    }>) {
      events.push(event);
    }

    expect(seenPath).toBe("/api/chat");
    expect(seenBody).toContain(cjkPrompt);

    const done = events.find((event) => event.type === "done");
    expect(done?.message?.usage?.input).toBe(expectedInput);
    expect(done?.message?.usage?.output).toBe(expectedOutput);
    expect(done?.message?.usage?.input).toBeGreaterThan(naivePromptEstimate * 2);
    expect(done?.message?.usage?.output).toBeGreaterThan(naiveCompletionEstimate * 2);
  });

  it("keeps provider-reported eval counts authoritative over the HTTP fallback", async () => {
    const cjkPrompt = "这是一个测试用的句子呢";
    const cjkCompletion = "你好世界测试";

    server = createServer((req, res) => {
      void (async () => {
        await readRequestBody(req);
        writeNdjson(res, [
          {
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:00Z",
            message: { role: "assistant", content: cjkCompletion },
            done: false,
          },
          {
            model: "qwen3.5",
            created_at: "2026-01-01T00:00:01Z",
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 77,
            eval_count: 19,
          },
        ]);
      })().catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });

    const port = await listenLocal(server);
    const streamFn = createOllamaStreamFn(`http://127.0.0.1:${port}`);
    const stream = streamFn(
      { api: "ollama", provider: "ollama", id: "qwen3.5", contextWindow: 65536 } as never,
      { messages: [{ role: "user", content: cjkPrompt }] } as never,
      {},
    );

    const events: Array<{
      type: string;
      message?: { usage?: { input?: number; output?: number } };
    }> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      message?: { usage?: { input?: number; output?: number } };
    }>) {
      events.push(event);
    }

    const done = events.find((event) => event.type === "done");
    expect(done?.message?.usage).toMatchObject({ input: 77, output: 19 });
  });
});
