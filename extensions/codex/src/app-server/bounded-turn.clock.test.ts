import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { codexModel, completedTurnResult } from "./bounded-turn.test-harness.js";
import { createWebSocketPeer } from "./client-websocket.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult, turnStartResult } from "./codex-app-server.test-fixtures.js";
import * as sharedClients from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

it.each([60_000, -60_000, 0])(
  "bounds the turn across clock corrections and cold discovery (%s)",
  async (clockStepMs) => {
    const cold = clockStepMs === 0;
    const thread = threadStartResult("clock-thread", process.cwd());
    const responses: Record<string, unknown> = {
      initialize: { userAgent: `codex/${CODEX_APP_SERVER_VERSION}` },
      "model/list": { data: [codexModel(thread.model)], nextCursor: null },
      "thread/start": thread,
      "turn/start": cold ? completedTurnResult() : turnStartResult("clock-turn"),
      "turn/interrupt": {},
    };
    let discoveryReply: (() => void) | undefined;
    const ready = createDeferred<void>();
    const peer = await createWebSocketPeer((request, respond, send) => {
      if (request.method === "initialized") {
        return;
      }
      expect(responses).toHaveProperty(request.method);
      if (cold && request.method === "model/list") {
        discoveryReply = () => respond(responses[request.method]);
      } else {
        respond(responses[request.method]);
      }
      if (request.method === (cold ? "model/list" : "turn/start")) {
        ready.resolve();
      }
      if (request.method === "turn/interrupt") {
        send({
          method: "turn/completed",
          params: { threadId: thread.thread.id, ...turnStartResult("clock-turn", "interrupted") },
        });
      }
    });
    const caller = new AbortController();
    let client: CodexAppServerClient | undefined;
    let run: Promise<unknown> | undefined;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    try {
      vi.spyOn(sharedClients, "createIsolatedCodexAppServerClient").mockImplementation(async () => {
        client = await CodexAppServerClient.start({ transport: "websocket", url: peer.url });
        await client.initialize();
        vi.setSystemTime(Date.now() + clockStepMs);
        return client;
      });
      run = runBoundedCodexAppServerTurn({
        model: { mode: "required", id: thread.model },
        timeoutMs: cold ? 30_000 : 1_000,
        signal: caller.signal,
        options: {},
        taskLabel: "clock and discovery proof",
        developerInstructions: "Answer only.",
        input: [{ type: "text", text: "Ready?", text_elements: [] }],
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }).catch((error: unknown) => error);
      await ready.promise;
      await vi.advanceTimersByTimeAsync(cold ? 5_008 : 1_000);
      discoveryReply?.();
      expect(await run).toMatchObject(
        cold ? { text: "The message was sent successfully." } : { name: "TimeoutError" },
      );
      expect(peer.methods.slice(-2)).toEqual(
        cold ? ["thread/start", "turn/start"] : ["turn/start", "turn/interrupt"],
      );
      expect(caller.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      caller.abort();
      await run;
      await client?.closeAndWait();
      await peer.close();
    }
  },
);
