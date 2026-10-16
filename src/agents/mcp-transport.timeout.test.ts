import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import {
  globalUndiciStreamTimeoutMs,
  setGlobalUndiciStreamTimeoutMs,
} from "../infra/net/undici-dispatcher-options.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { resolveMcpTransport } from "./mcp-transport.js";

// Advance Undici's own clock while keeping the HTTP and MCP clients real.
const undiciTimers: { tick: (delay: number) => void } = createRequire(import.meta.url)(
  "undici/lib/util/timers.js",
);

describe("MCP HTTP stream timeouts", () => {
  let previousStreamTimeoutMs: number | undefined;

  beforeEach(() => {
    previousStreamTimeoutMs = globalUndiciStreamTimeoutMs;
    setGlobalUndiciStreamTimeoutMs(1_000);
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      vi.stubEnv(name, "");
    }
  });

  afterEach(() => {
    setGlobalUndiciStreamTimeoutMs(previousStreamTimeoutMs);
    vi.unstubAllEnvs();
  });

  it.for(["headers", "body"] as const)(
    "completes a tool call silent beyond the default %s timeout",
    async (stage, { signal }) => {
      const toolReceived = createDeferred();
      const bodyReceived = createDeferred();
      const finishTool = createDeferred();
      const fixture = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            if (request.method !== "POST") {
              response.writeHead(405).end();
              return;
            }
            void (async () => {
              let body = "";
              for await (const chunk of request) {
                body += String(chunk);
              }
              const message = JSON.parse(body) as { id?: number; method: string };
              if (message.method === "initialize") {
                response.setHeader("content-type", "application/json");
                response.end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      protocolVersion: "2025-03-26",
                      capabilities: { tools: {}, logging: {} },
                      serverInfo: { name: "timeout-fixture", version: "1" },
                    },
                  }),
                );
                return;
              }
              if (message.method !== "tools/call") {
                response.writeHead(202).end();
                return;
              }
              if (stage === "body") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write(
                  'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"ready"}}\n\n',
                );
              }
              toolReceived.resolve();
              await finishTool.promise;
              const result = JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: "completed" }] },
              });
              if (stage === "body") {
                response.end(`data: ${result}\n\n`);
              } else {
                response.setHeader("content-type", "application/json");
                response.end(result);
              }
            })().catch((error: unknown) =>
              response.destroy(error instanceof Error ? error : undefined),
            );
          }),
      });
      const client = new Client({ name: "timeout-test", version: "1" });
      client.setNotificationHandler(LoggingMessageNotificationSchema, () => bodyReceived.resolve());
      const resolved = resolveMcpTransport("slow", {
        url: `http://127.0.0.1:${fixture.claim.port}/mcp`,
        transport: "streamable-http",
        requestTimeoutMs: 10_000,
      });

      try {
        if (!resolved) {
          throw new Error("Expected HTTP MCP transport");
        }
        await withinTest(client.connect(resolved.transport), signal);
        const pending = client.callTool({ name: "slow" }, undefined, {
          timeout: resolved.requestTimeoutMs,
        });
        const result = expect(pending).resolves.toMatchObject({
          content: [{ type: "text", text: "completed" }],
        });
        await withinTest(toolReceived.promise, signal);
        if (stage === "body") {
          await withinTest(bodyReceived.promise, signal);
        }
        undiciTimers.tick(0);
        undiciTimers.tick(2_000);
        finishTool.resolve();
        await withinTest(result, signal);
      } finally {
        finishTool.resolve();
        await client.close();
        fixture.listener.closeAllConnections();
        await fixture.releaseListener();
        await fixture.claim.release();
      }
    },
  );
});
