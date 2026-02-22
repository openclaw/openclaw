import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { handleZaloWebhookRequest, registerZaloWebhookTarget } from "./monitor.js";
import type { ResolvedZaloAccount } from "./types.js";

async function withServer(handler: RequestListener, fn: (baseUrl: string) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("missing server address");
  }
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("handleZaloWebhookRequest", () => {
  it("returns 400 for non-object payloads", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
    });

    try {
      await withServer(
        async (req, res) => {
          const handled = await handleZaloWebhookRequest(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("not found");
          }
        },
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/hook`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "secret",
              "content-type": "application/json",
            },
            body: "null",
          });

          expect(response.status).toBe(400);
          expect(await response.text()).toBe("Bad Request");
        },
      );
    } finally {
      unregister();
    }
  });

  it("rejects ambiguous routing when multiple targets match the same secret", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const sinkA = vi.fn();
    const sinkB = vi.fn();
    const unregisterA = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
      statusSink: sinkA,
    });
    const unregisterB = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook",
      mediaMaxMb: 5,
      statusSink: sinkB,
    });

    try {
      await withServer(
        async (req, res) => {
          const handled = await handleZaloWebhookRequest(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("not found");
          }
        },
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/hook`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "secret",
              "content-type": "application/json",
            },
            body: "{}",
          });

          expect(response.status).toBe(401);
          expect(sinkA).not.toHaveBeenCalled();
          expect(sinkB).not.toHaveBeenCalled();
        },
      );
    } finally {
      unregisterA();
      unregisterB();
    }
  });

  it("returns 415 for non-json content-type", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook-content-type",
      mediaMaxMb: 5,
    });

    try {
      await withServer(
        async (req, res) => {
          const handled = await handleZaloWebhookRequest(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("not found");
          }
        },
        async (baseUrl) => {
          const response = await fetch(`${baseUrl}/hook-content-type`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "secret",
              "content-type": "text/plain",
            },
            body: "{}",
          });

          expect(response.status).toBe(415);
        },
      );
    } finally {
      unregister();
    }
  });

  it("deduplicates webhook replay by event_name + message_id", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const sink = vi.fn();
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook-replay",
      mediaMaxMb: 5,
      statusSink: sink,
    });

    const payload = {
      event_name: "message.text.received",
      message: {
        from: { id: "123" },
        chat: { id: "123", chat_type: "PRIVATE" },
        message_id: "msg-replay-1",
        date: Math.floor(Date.now() / 1000),
        text: "hello",
      },
    };

    try {
      await withServer(
        async (req, res) => {
          const handled = await handleZaloWebhookRequest(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("not found");
          }
        },
        async (baseUrl) => {
          const first = await fetch(`${baseUrl}/hook-replay`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "secret",
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          const second = await fetch(`${baseUrl}/hook-replay`, {
            method: "POST",
            headers: {
              "x-bot-api-secret-token": "secret",
              "content-type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          expect(first.status).toBe(200);
          expect(second.status).toBe(200);
          expect(sink).toHaveBeenCalledTimes(1);
        },
      );
    } finally {
      unregister();
    }
  });

  it("returns 429 when per-path request rate exceeds threshold", async () => {
    const core = {} as PluginRuntime;
    const account: ResolvedZaloAccount = {
      accountId: "default",
      enabled: true,
      token: "tok",
      tokenSource: "config",
      config: {},
    };
    const unregister = registerZaloWebhookTarget({
      token: "tok",
      account,
      config: {} as OpenClawConfig,
      runtime: {},
      core,
      secret: "secret",
      path: "/hook-rate",
      mediaMaxMb: 5,
    });

    try {
      await withServer(
        async (req, res) => {
          const handled = await handleZaloWebhookRequest(req, res);
          if (!handled) {
            res.statusCode = 404;
            res.end("not found");
          }
        },
        async (baseUrl) => {
          let saw429 = false;
          for (let i = 0; i < 130; i += 1) {
            const response = await fetch(`${baseUrl}/hook-rate`, {
              method: "POST",
              headers: {
                "x-bot-api-secret-token": "secret",
                "content-type": "application/json",
              },
              body: "{}",
            });
            if (response.status === 429) {
              saw429 = true;
              break;
            }
          }

          expect(saw429).toBe(true);
        },
      );
    } finally {
      unregister();
    }
  });
});
