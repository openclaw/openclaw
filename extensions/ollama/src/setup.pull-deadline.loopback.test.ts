// Loopback proof: dripping /api/pull NDJSON cannot outlive the wall-clock deadline.
import { once } from "node:events";
import * as http from "node:http";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOllamaModelPulled } from "./setup.js";

function createDripPullServer(dripTimers: Set<ReturnType<typeof setInterval>>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url === "/api/pull") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const timer = setInterval(() => {
        res.write('{"status":"pulling manifest"}\n');
      }, 40);
      dripTimers.add(timer);
      res.on("close", () => {
        clearInterval(timer);
        dripTimers.delete(timer);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on("clientError", (_err, socket) => socket.destroy());
  return server;
}

function createPullPrompter(): {
  prompter: WizardPrompter;
  stopMessages: string[];
} {
  const stopMessages: string[] = [];
  const progress = {
    update: () => undefined,
    stop: (message: string) => {
      stopMessages.push(message);
    },
  };
  return {
    stopMessages,
    prompter: {
      progress: () => progress,
    } as unknown as WizardPrompter,
  };
}

function createLoopbackConfig(baseUrl: string) {
  return {
    agents: { defaults: { model: { primary: "ollama/gemma4" } } },
    models: {
      providers: {
        ollama: {
          baseUrl,
          models: [],
        },
      },
    },
  };
}

describe("Ollama pull stream wall-clock loopback", () => {
  let server: http.Server | undefined;
  const dripTimers = new Set<ReturnType<typeof setInterval>>();

  afterEach(async () => {
    for (const timer of dripTimers) {
      clearInterval(timer);
    }
    dripTimers.clear();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
        server?.closeAllConnections?.();
      });
      server = undefined;
    }
  });

  it("does not settle a dripping /api/pull body under idle timeout alone", async () => {
    server = createDripPullServer(dripTimers);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { prompter, stopMessages } = createPullPrompter();

    let settled = false;
    const pullPromise = ensureOllamaModelPulled({
      config: createLoopbackConfig(baseUrl),
      model: "ollama/gemma4",
      prompter,
      // Wall-clock above the idle observation window; drip keeps resetting idle.
      streamDeadlineMs: 1_500,
      streamIdleTimeoutMs: 100,
    }).finally(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(settled).toBe(false);

    // Cleanup: wall-clock still bounds the drip so afterEach does not hang.
    await expect(pullPromise).rejects.toMatchObject({
      name: "WizardCancelledError",
    });
    expect(stopMessages.some((message) => message.includes("wall-clock deadline"))).toBe(true);
  });

  it("aborts a dripping /api/pull body within the wall-clock deadline", async () => {
    server = createDripPullServer(dripTimers);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { prompter, stopMessages } = createPullPrompter();

    const startedAt = Date.now();
    await expect(
      ensureOllamaModelPulled({
        config: createLoopbackConfig(baseUrl),
        model: "ollama/gemma4",
        prompter,
        streamDeadlineMs: 250,
        streamIdleTimeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "WizardCancelledError",
      message: "Failed to download selected Ollama model",
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(stopMessages.some((message) => message.includes("wall-clock deadline"))).toBe(true);
  });
});
