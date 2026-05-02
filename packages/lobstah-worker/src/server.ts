import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { type WorkerEngine, OllamaEngine } from "@lobstah/engine-ollama";
import { append as appendLedger } from "@lobstah/ledger";
import {
  ChatCompletionRequestSchema,
  type Identity,
  RECEIPT_HEADER,
  RECEIPT_SSE_PREFIX,
  REQUESTER_HEADER,
  type Receipt,
  formatPubkey,
  generateNonce,
  signReceipt,
} from "@lobstah/protocol";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export type WorkerOptions = {
  identity: Identity;
  port?: number;
  host?: string;
  engine?: WorkerEngine;
};

export type RunningWorker = {
  port: number;
  pubkey: string;
  engine: string;
  stop: () => Promise<void>;
};

export type BuildWorkerAppOptions = {
  identity: Identity;
  engine?: WorkerEngine;
};

export type WorkerApp = {
  app: Hono;
  pubkey: string;
  engine: string;
};

const DEFAULT_PORT = 17474;

export const buildWorkerApp = (opts: BuildWorkerAppOptions): WorkerApp => {
  const engine: WorkerEngine = opts.engine ?? new OllamaEngine();
  const workerPubkey = formatPubkey(opts.identity.publicKey);

  const buildReceipt = (
    jobId: string,
    requesterPubkey: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    startedAt: number,
  ): Receipt => ({
    version: 1,
    jobId,
    nonce: generateNonce(),
    requesterPubkey,
    workerPubkey,
    model,
    inputTokens,
    outputTokens,
    startedAt,
    completedAt: Date.now(),
  });

  const app = new Hono();

  app.get("/", (c) => c.text("lobstah-worker\n"));
  app.get("/pubkey", (c) => c.json({ pubkey: workerPubkey }));

  app.get("/capacity", async (c) => {
    const models = await engine.listModels();
    return c.json({ pubkey: workerPubkey, models, queueDepth: 0 });
  });

  app.get("/v1/models", async (c) => {
    const models = await engine.listModels();
    return c.json({
      object: "list",
      data: models.map((id) => ({
        id,
        object: "model" as const,
        owned_by: `lobstah:${workerPubkey.slice(0, 12)}`,
      })),
    });
  });

  app.post("/v1/chat/completions", async (c) => {
    const requesterPubkey = c.req.header(REQUESTER_HEADER) ?? "anonymous";
    const raw = await c.req.json();
    const parsed = ChatCompletionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400);
    }

    const startedAt = Date.now();
    const jobId = randomUUID();

    if (parsed.data.stream) {
      let upstream;
      try {
        upstream = await engine.chatStream(parsed.data);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return c.json({ error: { type: "engine_error", message: msg } }, 502);
      }

      return streamSSE(c, async (sse) => {
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine) {
              const dataStr = dataLine.slice(6).trim();
              if (dataStr === "[DONE]") {
                continue;
              }
              try {
                const obj = JSON.parse(dataStr) as {
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (obj.usage) {
                  inputTokens = obj.usage.prompt_tokens ?? inputTokens;
                  outputTokens = obj.usage.completion_tokens ?? outputTokens;
                }
              } catch {
                // forward malformed chunks unchanged
              }
            }
            await sse.write(`${event}\n\n`);
          }
        }

        const receipt = buildReceipt(
          jobId,
          requesterPubkey,
          parsed.data.model,
          inputTokens,
          outputTokens,
          startedAt,
        );
        const signed = signReceipt(receipt, opts.identity.secretKey);
        await appendLedger(signed);
        const b64 = Buffer.from(JSON.stringify(signed), "utf8").toString("base64");
        await sse.write(`${RECEIPT_SSE_PREFIX}:${b64}\n\n`);
        await sse.write("data: [DONE]\n\n");
      });
    }

    let result;
    try {
      result = await engine.chat(parsed.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return c.json({ error: { type: "engine_error", message: msg } }, 502);
    }

    const receipt = buildReceipt(
      jobId,
      requesterPubkey,
      parsed.data.model,
      result.inputTokens,
      result.outputTokens,
      startedAt,
    );
    const signed = signReceipt(receipt, opts.identity.secretKey);
    await appendLedger(signed);
    c.header(RECEIPT_HEADER, Buffer.from(JSON.stringify(signed), "utf8").toString("base64"));
    return c.json(result.payload);
  });

  return { app, pubkey: workerPubkey, engine: engine.name };
};

export const startWorker = async (opts: WorkerOptions): Promise<RunningWorker> => {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? "0.0.0.0";
  const built = buildWorkerApp({ identity: opts.identity, engine: opts.engine });
  const server = serve({ fetch: built.app.fetch, hostname: host, port });
  return {
    port,
    pubkey: built.pubkey,
    engine: built.engine,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};
