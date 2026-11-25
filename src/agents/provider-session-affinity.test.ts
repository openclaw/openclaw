import { createServer, type IncomingHttpHeaders } from "node:http";
import { createApiRegistry, createLlmRuntime } from "@openclaw/ai";
import type { Model, StreamOptions } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { registerProviderStreamForModel } from "./provider-stream.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const completion =
  'data: {"id":"affinity","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"affinity-ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
type AffinityCase = [string, StreamOptions, string | undefined, boolean?, boolean?];

describe("registered managed completion API session affinity", () => {
  it.each<AffinityCase>([
    ["explicit cache key", { sessionId: "session", promptCacheKey: "cache-key" }, "cache-key"],
    ["long cache key", { sessionId: "session", promptCacheKey: "k".repeat(80) }, "k".repeat(64)],
    ["missing session", {}, undefined],
    ["cache disabled", { sessionId: "session", cacheRetention: "none" }, undefined],
    [
      "caller precedence",
      {
        sessionId: "session",
        headers: {
          SESSION_ID: "caller",
          "X-CLIENT-REQUEST-ID": "caller",
          "X-SESSION-AFFINITY": "caller",
        },
      },
      "caller",
    ],
    ["OpenRouter", { sessionId: "session" }, "session", true],
    ["OpenRouter configured", { sessionId: "session" }, "configured", true, true],
    [
      "OpenRouter caller",
      { sessionId: "session", headers: { "X-SESSION-ID": "caller" } },
      "caller",
      true,
      true,
    ],
  ])(
    "preserves %s through registered native and managed API aliases",
    async (name, options, expected, openrouter, configured) => {
      const requests: IncomingHttpHeaders[] = [];
      const server = createServer((request, response) => {
        requests.push(request.headers);
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(completion);
        });
      });
      try {
        const baseUrl = `${await listenLoopback(server)}/v1`;
        const model = attachModelProviderRequestTransport<Model<"openai-completions">>(
          makeProviderModelFixture<"openai-completions">({
            id: "affinity-fixture",
            name: "Affinity fixture",
            provider: "affinity-fixture",
            api: "openai-completions",
            baseUrl,
            contextWindow: 128000,
            compat: {
              sendSessionAffinityHeaders: true,
              ...(openrouter ? { thinkingFormat: "openrouter" } : {}),
            },
            headers: configured
              ? { "X-Session-ID": "configured" }
              : name === "caller precedence"
                ? {
                    Session_ID: "configured",
                    "X-Client-Request-ID": "configured",
                    "X-Session-Affinity": "configured",
                  }
                : undefined,
          }),
          { tls: { insecureSkipVerify: false } },
        );
        const registry = createApiRegistry();
        const streamFn = registerProviderStreamForModel({
          model,
          apiRegistry: registry,
          allowRuntimePluginLoad: false,
        });
        if (!streamFn) {
          throw new Error("Managed completion provider did not register");
        }
        ensureCustomApiRegistered(registry, "openclaw-openai-completions-transport", streamFn);
        const runtime = createLlmRuntime(registry);
        for (const api of ["openai-completions", "openclaw-openai-completions-transport"]) {
          const dispatchModel: Model = { ...model, api };
          const response = await runtime.complete(
            dispatchModel,
            {
              messages: [{ role: "user", content: "Reply affinity-ok", timestamp: 1 }],
            },
            { apiKey: "synthetic-loopback-key", ...options },
          );
          expect(response).toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: "affinity-ok" }],
          });
        }
        expect(requests).toHaveLength(2);
        for (const headers of requests) {
          for (const header of ["session_id", "x-client-request-id", "x-session-affinity"]) {
            expect(headers[header], header).toBe(openrouter ? undefined : expected);
          }
          expect(headers["x-session-id"]).toBe(openrouter ? expected : undefined);
        }
      } finally {
        await closeHttpServer(server);
      }
    },
  );
});
