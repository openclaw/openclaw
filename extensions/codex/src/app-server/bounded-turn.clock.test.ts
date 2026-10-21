import { expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { codexModel } from "./bounded-turn.test-harness.js";
import { createWebSocketPeer } from "./client-websocket.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult, turnStartResult } from "./codex-app-server.test-fixtures.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

it.each([60_000, -60_000])(
  "keeps the bounded WebSocket turn timeout after a %s ms startup clock correction",
  async (clockStepMs) => {
    const thread = threadStartResult("clock-thread", process.cwd());
    const turn = turnStartResult("clock-turn");
    const responses: Record<string, unknown> = {
      initialize: { userAgent: `codex/${CODEX_APP_SERVER_VERSION}` },
      "model/list": { data: [codexModel(thread.model)], nextCursor: null },
      "thread/start": thread,
      "turn/start": turn,
      "turn/interrupt": {},
    };
    const peer = await createWebSocketPeer((request, respond, send) => {
      if (Object.hasOwn(responses, request.method)) {
        respond(responses[request.method]);
      } else if (request.method !== "initialized") {
        send({
          id: request.id,
          error: { code: -32601, message: `Unexpected method: ${request.method}` },
        });
      }
      if (request.method === "turn/interrupt") {
        send({
          method: "turn/completed",
          params: {
            threadId: thread.thread.id,
            ...turnStartResult(turn.turn.id, "interrupted"),
          },
        });
      }
    });

    const realDateNow = Date.now;
    const wallClock = vi.spyOn(Date, "now");
    const caller = new AbortController();
    let client: CodexAppServerClient | undefined;
    let initialized = false;
    let run: Promise<unknown> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedAt = performance.now();
      // Bound the old backward-clock bug without simulating its expiry.
      watchdog = setTimeout(() => {
        caller.abort(new Error("clock proof watchdog"));
        if (!initialized) {
          client?.close();
        }
      }, 4_000);
      run = runBoundedCodexAppServerTurn({
        model: { mode: "required", id: thread.model },
        timeoutMs: 1_000,
        signal: caller.signal,
        options: {
          clientFactory: async () => {
            client = await CodexAppServerClient.start({
              transport: "websocket",
              url: peer.url,
            });
            await client.initialize();
            initialized = true;
            // Apply one process-local offset after startup, never an OS clock change.
            wallClock.mockImplementation(() => realDateNow() + clockStepMs);
            return client;
          },
        },
        taskLabel: "clock proof",
        developerInstructions: "Wait for cancellation.",
        input: [{ type: "text", text: "Clock proof.", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }).catch((error: unknown) => error);
      const outcome = await run;
      const elapsedMs = performance.now() - startedAt;
      expect(peer.methods).toEqual([
        "initialize",
        "initialized",
        "model/list",
        "thread/start",
        "turn/start",
        "turn/interrupt",
      ]);
      expect(outcome).toMatchObject({
        name: "TimeoutError",
        message: "codex app-server clock proof turn timed out after 1s",
      });
      expect(caller.signal.aborted).toBe(false);
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(4_000);
    } finally {
      clearTimeout(watchdog);
      wallClock.mockRestore();
      caller.abort();
      await run;
      await client?.closeAndWait();
      await peer.close();
    }
  },
);
