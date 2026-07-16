// Loopback proof: dripping /api/pull NDJSON cannot outlive the wall-clock deadline.
import { once } from "node:events";
import * as http from "node:http";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it } from "vitest";
import { ensureOllamaModelPulled } from "./setup.js";

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

  it("aborts a dripping /api/pull body within the wall-clock deadline", async () => {
    server = http.createServer((req, res) => {
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const stopMessages: string[] = [];
    const progress = {
      update: () => undefined,
      stop: (message: string) => {
        stopMessages.push(message);
      },
    };
    const prompter = {
      progress: () => progress,
    } as unknown as WizardPrompter;

    const startedAt = Date.now();
    await expect(
      ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "ollama/gemma4" } } },
          models: {
            providers: {
              ollama: {
                baseUrl,
                models: [],
              },
            },
          },
        },
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
