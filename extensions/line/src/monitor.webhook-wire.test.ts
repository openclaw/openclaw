import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { monitorLineProvider } from "./monitor.js";

type LineNodeWebhookHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

const { createLineBotMock, registerWebhookTargetWithPluginRouteMock } = vi.hoisted(() => ({
  createLineBotMock: vi.fn(),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

function requireRegisteredHandler(): LineNodeWebhookHandler {
  const registration = registerWebhookTargetWithPluginRouteMock.mock.calls[0]?.[0] as
    | { route?: { handler?: LineNodeWebhookHandler } }
    | undefined;
  const handler = registration?.route?.handler;
  if (!handler) {
    throw new Error("expected registered LINE webhook route");
  }
  return handler;
}

function postSigned(url: string, body: string, bytes: number) {
  return postRawWebhook({
    url,
    body,
    chunkedEncoding: true,
    chunk: { bytes, intervalMs: 1 },
    headers: {
      "content-type": "application/json",
      "x-line-signature": crypto.createHmac("SHA256", "secret").update(body).digest("base64"),
    },
  });
}

describe("monitorLineProvider webhook body limits over a real connection", () => {
  beforeEach(() => {
    createLineBotMock.mockReset().mockImplementation(() => ({
      account: { accountId: "default" },
      handleWebhook: vi.fn(async () => "durable" as const),
      stop: vi.fn(async () => undefined),
    }));
    // Signature matching needs the same target map as the registered route.
    registerWebhookTargetWithPluginRouteMock.mockReset().mockImplementation((params) => {
      const key = params.target.path.toLowerCase();
      const normalizedTarget = { ...params.target, path: key };
      params.targetsByPath.set(key, [...(params.targetsByPath.get(key) ?? []), normalizedTarget]);
      return {
        target: normalizedTarget,
        unregister: () => params.targetsByPath.delete(key),
      };
    });
  });

  afterAll(() => {
    vi.doUnmock("./bot.js");
    vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
    vi.resetModules();
  });

  const withLineWebhookWire = async (run: (webhookUrl: string) => Promise<void>) => {
    const monitor = await monitorLineProvider({
      channelAccessToken: "token",
      channelSecret: "secret", // pragma: allowlist secret
      accountId: "default",
      config: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
    });
    const handler = requireRegisteredHandler();
    try {
      await withServer(
        (req, res) => {
          void handler(req, res);
        },
        (baseUrl) => run(`${baseUrl}/line/webhook`),
      );
    } finally {
      await monitor.stop();
    }
  };

  it("counts UTF-8 bytes, not characters, for a chunked non-ASCII webhook", async () => {
    // The under-cap control proves byte-exact chunk framing, not just rejection.
    await withLineWebhookWire(async (webhookUrl) => {
      const body = (length: number) =>
        JSON.stringify({ events: [{ type: "message" }], padding: "壓".repeat(length) });
      const overCap = body(30_000);
      expect(overCap.length).toBeLessThan(64 * 1024);
      expect(Buffer.byteLength(overCap, "utf-8")).toBeGreaterThan(64 * 1024);
      const rejected = await postSigned(webhookUrl, overCap, 8 * 1024);
      expect(rejected).toMatchObject({
        statusLine: "HTTP/1.1 413 Payload Too Large",
        closedByServer: true,
      });
      expect(JSON.parse(rejected.body)).toEqual({ error: "Payload too large" });

      const accepted = await postSigned(webhookUrl, body(1_000), 1024);
      expect(accepted.statusLine).toBe("HTTP/1.1 200 OK");
      expect(JSON.parse(accepted.body)).toEqual({ status: "ok" });
    });
  });
});
