import type { AddressInfo } from "node:net";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedZaloAccount } from "./types.js";
import { handleZaloWebhookRequest, registerZaloWebhookTarget } from "./monitor.js";

async function withServer(
  handler: Parameters<typeof createServer>[0],
  fn: (baseUrl: string) => Promise<void>,
) {
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
            },
            body: "null",
          });

          expect(response.status).toBe(400);
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
});
