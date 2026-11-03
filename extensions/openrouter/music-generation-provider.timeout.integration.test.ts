// Exercise the provider's deadline through real guarded HTTP response bodies.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { channel } from "node:diagnostics_channel";
import { createServer, type ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../test-support/hanging-loopback-server.js";
import { buildOpenRouterMusicGenerationProvider } from "./music-generation-provider.js";

const resolveContext = vi.hoisted(() => vi.fn());
vi.mock("./generation-request-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./generation-request-context.js")>()),
  resolveOpenRouterGenerationRequestContext: resolveContext,
}));

describe("OpenRouter music HTTP deadline", () => {
  it.each(["stalled", "trickling"])("aborts a %s response after headers", async (mode) => {
    const responseReady = Promise.withResolvers<ServerResponse>();
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"audio":{"transcript":"start"}}}]}\n');
      responseReady.resolve(response);
    });
    const port = await listenOnLoopback(server);
    const origin = `http://127.0.0.1:${port}`;
    resolveContext.mockResolvedValue({
      baseUrl: `${origin}/api/v1`,
      allowPrivateNetwork: true,
      headers: new Headers({ authorization: "Bearer synthetic-test-key" }),
      dispatcherPolicy: undefined,
    });

    let received = Promise.withResolvers<void>();
    const chunks = channel("undici:request:bodyChunkReceived");
    const onChunk = (message: unknown) => {
      const event = message as { request: { origin: string } };
      if (event.request.origin === origin) {
        received.resolve();
      }
    };
    chunks.subscribe(onChunk);
    // Only the deadline clock is fake: HTTP, headers and body delivery stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const operation = buildOpenRouterMusicGenerationProvider().generateMusic({
      provider: "openrouter",
      model: "",
      prompt: "synthetic timeout soundtrack",
      cfg: {},
      timeoutMs: 1,
    });
    const outcome = operation.catch((error: unknown) => error);
    try {
      await received.promise;
      await setImmediate();
      if (mode === "trickling") {
        await vi.advanceTimersByTimeAsync(0.5);
        received = Promise.withResolvers<void>();
        (await responseReady.promise).write(": keepalive\n");
        await received.promise;
        await setImmediate();
        await vi.advanceTimersByTimeAsync(0.5);
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await outcome).toMatchObject({
        message: "OpenRouter music generation timed out after 1ms",
      });
    } finally {
      chunks.unsubscribe(onChunk);
      vi.useRealTimers();
      server.closeAllConnections();
      await server[Symbol.asyncDispose]();
      await outcome;
      resolveContext.mockReset();
    }
  });
});
