import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  writeRestartJsonText,
  writeRestartToolCall,
} from "../../test/gateway-restart.test-support.ts";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.ts";

/** Captures request metadata only. Authorization is forwarded in memory, never recorded. */
export async function startRestartStressProvider(options: {
  dry: boolean;
  model: string;
  onActivity: (id: string, at: number) => void;
  onSustainedRateLimit: () => void;
}) {
  let rejectUntil = 0;
  const counters = { requests: 0, injected429: 0, upstream429: 0, fallbackRequests: 0 };
  const requests: Array<{
    at: number;
    id?: string;
    primary: boolean;
    streaming: boolean;
    status?: number;
  }> = [];
  const upstreamLimits: number[] = [];
  const continuations = new Map<string, { id: string; effect?: string }>();
  const controller = new AbortController();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body)) {
        throw new Error("Invalid provider body");
      }
      const text = JSON.stringify(body.input ?? body.messages ?? "");
      const previous =
        typeof body.previous_response_id === "string"
          ? continuations.get(body.previous_response_id)
          : undefined;
      const id = [...text.matchAll(/INPUT_([a-z0-9-]+)/g)].at(-1)?.[1] ?? previous?.id;
      const primary = body.model === "stress-primary";
      const entry: (typeof requests)[number] = {
        at: Date.now(),
        id,
        primary,
        streaming: body.stream !== false,
      };
      requests.push(entry);
      counters.requests++;
      if (!primary) {
        counters.fallbackRequests++;
      }
      if (id) {
        options.onActivity(id, entry.at);
      }
      if (primary && Date.now() < rejectUntil) {
        counters.injected429++;
        entry.status = 429;
        const retryAfterSeconds = Math.max(1, Math.ceil((rejectUntil - Date.now()) / 1000));
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": String(retryAfterSeconds),
        });
        response.end(
          JSON.stringify({
            error: {
              message: `Rate limit reached for stress-primary in organization synthetic on tokens per min (TPM): Limit 100, Used 100, Requested 10. Please try again in ${retryAfterSeconds}s.`,
              type: "tokens",
              code: "rate_limit_exceeded",
            },
          }),
        );
        return;
      }
      if (options.dry) {
        const input = Array.isArray(body.input) ? body.input : [];
        const lastUser = input.findLastIndex((item) => isRecord(item) && item.role === "user");
        const hasOutput = input
          .slice(lastUser + 1)
          .some((item) => isRecord(item) && item.type === "function_call_output");
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const canExec = tools.some((tool) => isRecord(tool) && tool.name === "exec");
        const effect = /EFFECT_PATH=([^\s"\\]+)/.exec(text)?.[1] ?? previous?.effect;
        entry.status = 200;
        if (body.stream === false) {
          writeRestartJsonText(response, "Synthetic stress title", randomUUID(), {
            object: true,
            completed: true,
          });
        } else if (id && effect && canExec && !hasOutput) {
          const key = randomUUID();
          continuations.set(`resp_${key}_${counters.requests}`, { id, effect });
          writeRestartToolCall(
            response,
            key,
            "exec",
            {
              command: `if ! grep -Fxq -- 'EFFECT_${id}' '${effect}' 2>/dev/null; then printf '%s\\n' 'EFFECT_${id}' >> '${effect}'; fi; sleep 12`,
              yieldMs: 1000,
            },
            counters.requests,
          );
        } else {
          if (id && effect) {
            await delay(15_000, undefined, { signal: controller.signal });
          }
          writeOpenAiResponsesText(response, {
            text: id ? `DONE_${id}` : "Synthetic stress title",
            messageId: `msg_${randomUUID()}`,
            responseId: `resp_${randomUUID()}`,
          });
        }
        return;
      }
      body.model = options.model;
      controller.signal.throwIfAborted();
      const upstream = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: request.headers.authorization ?? "",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      entry.status = upstream.status;
      if (upstream.status === 429) {
        counters.upstream429++;
        upstreamLimits.push(Date.now());
        if (upstreamLimits.filter((at) => at > Date.now() - 60_000).length >= 3) {
          options.onSustainedRateLimit();
          controller.abort();
        }
      }
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      if (upstream.body) {
        const reader = upstream.body.getReader();
        await pipeline(
          Readable.from(
            (async function* () {
              try {
                while (true) {
                  const chunk = await reader.read();
                  if (chunk.done) {
                    return;
                  }
                  yield chunk.value;
                }
              } finally {
                reader.releaseLock();
              }
            })(),
          ),
          response,
        );
      } else {
        response.end();
      }
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider listener missing");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    counters,
    requests,
    rejectFor(ms: number) {
      rejectUntil = Date.now() + ms;
      return rejectUntil;
    },
    async close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
