// Loopback proof: dripping /api/pull NDJSON cannot outlive the no-progress timeout,
// while monotonically advancing `completed` may continue past that shortened budget.
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

function createStatusFinalizationPullServer(
  dripTimers: Set<ReturnType<typeof setInterval>>,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url === "/api/pull") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      let completed = 0;
      let step = 0;
      const statusPhases = [
        "verifying sha256 digest",
        "writing manifest",
        "pulling manifest",
        "checking blob",
        "cleanup",
      ];
      const timer = setInterval(() => {
        if (step < 5) {
          completed += 250;
          res.write(`{"status":"downloading","total":1250,"completed":${completed}}\n`);
        } else {
          const phaseIdx = step - 5;
          if (phaseIdx < statusPhases.length) {
            res.write(`{"status":"${statusPhases[phaseIdx]}"}\n`);
          } else {
            // Spent >statusPhases.length status-only steps past the 100ms
            // budget; healthy finalization survives because distinct status
            // transitions reset the watchdog each step.
            res.write('{"status":"success"}\n');
            res.end();
            clearInterval(timer);
            dripTimers.delete(timer);
          }
        }
        step++;
      }, 30);
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

function createAdvancingPullServer(dripTimers: Set<ReturnType<typeof setInterval>>): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    if (req.url === "/api/pull") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      let completed = 0;
      const timer = setInterval(() => {
        completed += 250;
        res.write(`{"status":"downloading","total":2000,"completed":${completed}}\n`);
        if (completed >= 2000) {
          res.write('{"status":"success"}\n');
          res.end();
          clearInterval(timer);
          dripTimers.delete(timer);
        }
      }, 80);
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

describe("Ollama pull stream no-progress loopback", () => {
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
      // No-progress above the idle observation window; drip keeps resetting idle.
      streamNoProgressTimeoutMs: 1_500,
      streamIdleTimeoutMs: 100,
    }).finally(() => {
      settled = true;
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 500);
    });
    expect(settled).toBe(false);

    // Cleanup: no-progress still bounds the drip so afterEach does not hang.
    await expect(pullPromise).rejects.toMatchObject({
      name: "WizardCancelledError",
    });
    expect(stopMessages.some((message) => message.includes("no progress for"))).toBe(true);
  });

  it("aborts a non-advancing dripping /api/pull body within the no-progress timeout", async () => {
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
        streamNoProgressTimeoutMs: 250,
        streamIdleTimeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({
      name: "WizardCancelledError",
      message: "Failed to download selected Ollama model",
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(200);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(stopMessages.some((message) => message.includes("no progress for"))).toBe(true);
  });

  it("allows status-only finalization past the shortened no-progress timeout", async () => {
    server = createStatusFinalizationPullServer(dripTimers);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { prompter, stopMessages } = createPullPrompter();

    await ensureOllamaModelPulled({
      config: createLoopbackConfig(baseUrl),
      model: "ollama/gemma4",
      prompter,
      // Status-only finalization phases (~180ms total) survive past a 100ms budget
      // because distinct status transitions reset the no-progress watchdog.
      streamNoProgressTimeoutMs: 100,
      streamIdleTimeoutMs: 10_000,
    });
    expect(stopMessages).toContain("Downloaded gemma4");
    expect(stopMessages.some((message) => message.includes("no progress for"))).toBe(false);
  });

  it("allows advancing completed progress past the shortened no-progress timeout", async () => {
    server = createAdvancingPullServer(dripTimers);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const { prompter, stopMessages } = createPullPrompter();

    const startedAt = Date.now();
    await ensureOllamaModelPulled({
      config: createLoopbackConfig(baseUrl),
      model: "ollama/gemma4",
      prompter,
      // Full advancing download needs ~640ms; no-progress window is shorter.
      streamNoProgressTimeoutMs: 250,
      streamIdleTimeoutMs: 10_000,
    });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(400);
    expect(elapsedMs).toBeLessThan(3_000);
    expect(stopMessages).toContain("Downloaded gemma4");
    expect(stopMessages.some((message) => message.includes("no progress for"))).toBe(false);
  });
});
