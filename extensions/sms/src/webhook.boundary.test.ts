import { createHmac } from "node:crypto";
import { request, type RequestListener } from "node:http";
import { createConnection } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
} from "./webhook.test-support.js";

const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async (_form: Record<string, string>) => ({ kind: "accepted" as const, duplicate: false })),
);
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    enqueue: enqueueSmsIngress,
    start: vi.fn(),
    pause: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  })),
);

vi.mock("./ingress-spool.js", () => ({ createSmsIngressSpool }));

vi.mock("node:timers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers")>();
  return {
    ...actual,
    setTimeout: ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      globalThis.setTimeout(callback, delay, ...args)) as typeof actual.setTimeout,
    clearTimeout: ((timer: ReturnType<typeof globalThis.setTimeout> | undefined) =>
      globalThis.clearTimeout(timer)) as typeof actual.clearTimeout,
  };
});

function holdIncompletePost(port: number, index: number) {
  const body = new URLSearchParams({ incomplete: String(index) }).toString();
  const req = request({
    host: "127.0.0.1",
    port,
    path: "/webhooks/sms",
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(body),
    },
  });
  const result = new Promise<number>((resolve, reject) => {
    req.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode ?? 0));
    });
    req.once("error", reject);
  });
  void result.catch(() => {});
  req.write(body.slice(0, 1));
  return {
    request: req,
    finish: () => req.end(body.slice(1)),
    result,
  };
}

function sendIncompleteRawPost(port: number) {
  return new Promise<{ response: string; endedByServer: boolean }>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let endedByServer = false;
    socket.once("connect", () => {
      socket.write(
        "POST /webhooks/sms HTTP/1.1\r\n" +
          `Host: 127.0.0.1:${port}\r\n` +
          "Content-Type: application/x-www-form-urlencoded\r\n" +
          "Content-Length: 1024\r\n" +
          "Connection: keep-alive\r\n\r\n",
      );
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("end", () => {
      endedByServer = true;
      socket.end();
    });
    socket.once("close", () => {
      resolve({ response: Buffer.concat(chunks).toString("utf8"), endedByServer });
    });
    socket.once("error", reject);
  });
}

beforeEach(() => {
  enqueueSmsIngress.mockReset();
  enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
  advanceSmsTestAccountId();
});

it("closes overflow uploads and recovers capacity for a signed callback", async () => {
  const account = createSmsTestAccount({ accountId: "boundary" });
  const registry = createEmptyPluginRegistry();
  const previousRegistry = getActivePluginRegistry();
  setActivePluginRegistry(registry);
  const abortController = new AbortController();
  const lifecycle = startSmsGatewayAccount({
    cfg: {},
    account,
    channelRuntime: {} as SmsChannelRuntime,
    abortSignal: abortController.signal,
  });
  await vi.waitFor(() => expect(registry.httpRoutes).toHaveLength(1));
  const route = registry.httpRoutes[0];
  if (!route) {
    throw new Error("expected the SMS gateway to register its account route");
  }

  const received = { requests: 0, bodyReaders: 0 };
  const handler: RequestListener = (req, res) => {
    received.requests += 1;
    if (received.requests <= 64) {
      req.once("data", () => {
        received.bodyReaders += 1;
      });
    }
    void Promise.resolve(route.handler(req, res)).catch((error: unknown) => {
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      }
    });
  };
  const held: ReturnType<typeof holdIncompletePost>[] = [];

  try {
    await withServer(handler, async (baseUrl) => {
      const port = Number(new URL(baseUrl).port);
      try {
        for (let index = 0; index < 64; index += 1) {
          held.push(holdIncompletePost(port, index));
        }
        await vi.waitFor(() => expect(received).toEqual({ requests: 64, bodyReaders: 64 }), {
          timeout: 10_000,
        });

        // Header-only input plus peer closure proves early rejection; Bun marks req.complete on response end.
        const overflow = await sendIncompleteRawPost(port);
        expect(overflow.response).toContain("HTTP/1.1 429 Too Many Requests\r\n");
        expect(overflow.response).toMatch(/\r\nConnection: close\r\n/iu);
        expect(overflow.response).toContain("\r\n\r\nRate limit exceeded");
        expect(overflow.endedByServer).toBe(true);
        expect(enqueueSmsIngress).not.toHaveBeenCalled();

        for (const pending of held) {
          pending.finish();
        }
        const released = await Promise.all(held.map((pending) => pending.result));
        expect(released.every((statusCode) => statusCode === 403)).toBe(true);

        const form: Record<string, string> = {
          AccountSid: account.accountSid,
          From: "+15551234567",
          To: account.fromNumber,
          Body: "boundary proof",
          MessageSid: "SM00000000000000000000000000000985",
        };
        const body = new URLSearchParams(form).toString();
        const signed =
          account.publicWebhookUrl +
          Object.keys(form)
            .toSorted()
            .map((key) => `${key}${form[key] ?? ""}`)
            .join("");
        const admitted = await fetch(`${baseUrl}/webhooks/sms`, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": createHmac("sha1", account.authToken)
              .update(signed)
              .digest("base64"),
          },
        });

        expect(admitted.status).toBe(200);
        expect(admitted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        await admitted.text();
        expect(enqueueSmsIngress).toHaveBeenCalledOnce();
        expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
      } finally {
        for (const pending of held) {
          pending.request.destroy();
        }
        await Promise.allSettled(held.map((pending) => pending.result));
      }
    });
  } finally {
    abortController.abort();
    await lifecycle;
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  }
});
it.each([
  [false, "HTTP/1.1 413 Payload Too Large", "Payload too large"],
  [true, "HTTP/1.1 500 Internal Server Error", "Internal Server Error"],
] as const)(
  "flushes a rejection and closes the upload (timeout=%s)",
  async (timeout, statusLine, responseBody) => {
    const delivery = createSmsTestDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createSmsTestAccount(),
      ingress: { enqueue: enqueueSmsIngress },
      delivery,
    });
    let routeError: unknown;
    const requestReceived = createDeferred<void>();
    await withServer(
      (req, res) => {
        void handler(req, res).catch((error: unknown) => {
          routeError = error;
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Internal Server Error");
        });
        // Observe after installing the reader; Bun's wrapper omits raw socket data events.
        req.once("data", () => requestReceived.resolve());
      },
      async (baseUrl) => {
        if (timeout) {
          vi.useFakeTimers();
        }
        try {
          const resultPromise = postRawWebhook({
            url: `${baseUrl}/sms`,
            body: timeout ? "x" : "x".repeat(32 * 1024 + 1),
            ...(timeout ? { contentLength: 2, idleTimeoutMs: 10_000 } : {}),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": "unused",
            },
          });

          if (timeout) {
            await requestReceived.promise;
            await vi.advanceTimersByTimeAsync(6_000);
          }
          await expect(resultPromise).resolves.toMatchObject({
            statusLine,
            body: responseBody,
            headers: { connection: "close" },
            closedByServer: true,
          });
          expect(routeError).toBeUndefined();
          expect(enqueueSmsIngress).not.toHaveBeenCalled();
          expect(delivery.record).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  },
);
