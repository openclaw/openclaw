import { createServer, type Server } from "node:http";
import { createOpenAIResponsesTransportStreamFn } from "@openclaw/ai/transports";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { classifyAssistantFailoverReason } from "../embedded-agent-helpers/assistant-message-failures.js";
import { resolveRunFailoverDecision } from "../embedded-agent-runner/run/failover-policy.js";

// A CDN-fronted provider outage as it actually arrives: an HTML page carrying no
// provider error type, over a real socket, through the shipped transport. The
// reason it produces decides whether retry-limit exhaustion consults the
// configured fallback chain, so this covers the whole chain rather than a
// hand-built signal.
const CLOUDFLARE_ERROR_PAGE = (status: number) =>
  `<!doctype html><html><head><title>${status}</title></head>` +
  `<body><h1>${status}</h1><p>cloudflare-nginx</p></body></html>`;

const FALLBACK_REPLY = "recovered on the fallback model";

async function startServer(handler: Parameters<typeof createServer>[0]): Promise<{
  port: number;
  close: () => Promise<void>;
  server: Server;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing loopback server address");
  }
  return {
    port: address.port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

function failingWith(status: number) {
  return ((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(CLOUDFLARE_ERROR_PAGE(status));
    });
  }) satisfies Parameters<typeof createServer>[0];
}

function completingWith(text: string) {
  return ((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      const event = {
        type: "response.completed",
        sequence_number: 0,
        response: {
          id: "resp-fallback-ok",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg-fallback-ok",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        },
      };
      response.write(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
  }) satisfies Parameters<typeof createServer>[0];
}

function modelAt(port: number, id: string) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  } satisfies Model;
}

async function runTurn(model: Model) {
  const stream = await createOpenAIResponsesTransportStreamFn()(
    model,
    { messages: [{ role: "user", content: "ping", timestamp: 0 }], tools: [] },
    { apiKey: "test-key" },
  );
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("provider 5xx recovery through the real transport", () => {
  it("recovers on the fallback model after a live 502 on the primary", async () => {
    const primary = await startServer(failingWith(502));
    const fallback = await startServer(completingWith(FALLBACK_REPLY));
    try {
      // 1. The primary fails over a real socket. The shipped transport reports a
      //    502 as a terminal error message rather than a throw.
      const primaryEvents = await runTurn(modelAt(primary.port, "primary-model"));
      const terminal = primaryEvents.find((event) => event.type === "error");
      expect(terminal).toBeDefined();
      const assistant = terminal?.type === "error" ? terminal.error : undefined;
      expect(assistant?.stopReason).toBe("error");

      // 2. Production classifies that real message.
      const reason = classifyAssistantFailoverReason(assistant, { provider: "openai" });
      expect(reason).toBe("server_error");

      // 3. Retry-limit exhaustion therefore consults the configured chain.
      expect(
        resolveRunFailoverDecision({
          stage: "retry_limit",
          fallbackConfigured: true,
          failoverReason: reason,
        }),
      ).toEqual({ action: "fallback_model", reason: "server_error" });

      // 4. The fallback candidate then really answers, over its own socket.
      const fallbackEvents = await runTurn(modelAt(fallback.port, "fallback-model"));
      const done = fallbackEvents.find((event) => event.type === "done");
      expect(done).toBeDefined();
      const text =
        done?.type === "done"
          ? done.message.content.map((b) => (b.type === "text" ? b.text : "")).join("")
          : "";
      expect(text).toContain(FALLBACK_REPLY);
    } finally {
      await primary.close();
      await fallback.close();
    }
  });

  it("keeps a live 504 a timeout, so retry-limit does not escalate to fallback", async () => {
    // The timing-status control: same shape, same transport, different status.
    const gateway = await startServer(failingWith(504));
    try {
      const events = await runTurn(modelAt(gateway.port, "primary-model"));
      const terminal = events.find((event) => event.type === "error");
      const assistant = terminal?.type === "error" ? terminal.error : undefined;
      const reason = classifyAssistantFailoverReason(assistant, { provider: "openai" });
      expect(reason).toBe("timeout");
      expect(
        resolveRunFailoverDecision({
          stage: "retry_limit",
          fallbackConfigured: true,
          failoverReason: reason,
        }),
      ).toEqual({ action: "return_error_payload" });
    } finally {
      await gateway.close();
    }
  });
});
