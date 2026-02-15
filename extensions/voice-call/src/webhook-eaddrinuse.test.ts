import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { VoiceCallWebhookServer } from "./webhook.js";

// Occupy a port so the webhook server hits EADDRINUSE
function occupyPort(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: http.Server | null): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
}

describe("VoiceCallWebhookServer EADDRINUSE retry", () => {
  const servers: http.Server[] = [];
  let webhook: VoiceCallWebhookServer | null = null;

  afterEach(async () => {
    if (webhook) {
      await webhook.stop();
      webhook = null;
    }
    for (const s of servers) {
      await closeServer(s);
    }
    servers.length = 0;
  });

  it("falls back to next port when configured port is occupied", async () => {
    const basePort = 19876;
    const blocker = await occupyPort(basePort);
    servers.push(blocker);

    webhook = new VoiceCallWebhookServer({
      serve: { port: basePort, bind: "127.0.0.1", path: "/voice/webhook" },
      providers: {},
    });

    const url = await webhook.start();
    expect(url).toBe(`http://127.0.0.1:${basePort + 1}/voice/webhook`);
  });

  it("skips multiple occupied ports", async () => {
    const basePort = 19877;
    servers.push(await occupyPort(basePort));
    servers.push(await occupyPort(basePort + 1));

    webhook = new VoiceCallWebhookServer({
      serve: { port: basePort, bind: "127.0.0.1", path: "/voice/webhook" },
      providers: {},
    });

    const url = await webhook.start();
    expect(url).toBe(`http://127.0.0.1:${basePort + 2}/voice/webhook`);
  });

  it("throws after exhausting retries", async () => {
    const basePort = 19880;
    for (let i = 0; i <= 3; i++) {
      servers.push(await occupyPort(basePort + i));
    }

    webhook = new VoiceCallWebhookServer({
      serve: { port: basePort, bind: "127.0.0.1", path: "/voice/webhook" },
      providers: {},
    });

    await expect(webhook.start()).rejects.toThrow();
  });

  it("starts on configured port when available", async () => {
    const basePort = 19884;

    webhook = new VoiceCallWebhookServer({
      serve: { port: basePort, bind: "127.0.0.1", path: "/voice/webhook" },
      providers: {},
    });

    const url = await webhook.start();
    expect(url).toBe(`http://127.0.0.1:${basePort}/voice/webhook`);
  });
});
