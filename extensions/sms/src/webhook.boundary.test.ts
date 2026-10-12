import { createHmac } from "node:crypto";
import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import { createConnection } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestDeliveryRecorder,
} from "./webhook.test-support.js";

const enqueueSmsIngress = vi.hoisted(() =>
  vi.fn(async (_form: Record<string, string>) => ({ kind: "accepted" as const, duplicate: false })),
);
const startSmsIngress = vi.hoisted(() => vi.fn());
const pauseSmsIngress = vi.hoisted(() => vi.fn(async () => {}));
const stopSmsIngress = vi.hoisted(() => vi.fn(async () => {}));
const createSmsIngressSpool = vi.hoisted(() =>
  vi.fn(() => ({
    enqueue: enqueueSmsIngress,
    start: startSmsIngress,
    pause: pauseSmsIngress,
    stop: stopSmsIngress,
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

type HttpResult = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
};

type HeldRequest = {
  request: ClientRequest;
  finish: () => void;
  result: Promise<HttpResult>;
};

function readResponse(req: ClientRequest): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.once("error", reject);
  });
}

function holdIncompletePost(port: number, index: number): HeldRequest {
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
  const result = readResponse(req);
  void result.catch(() => {});
  req.write(body.slice(0, 1));
  return {
    request: req,
    finish: () => req.end(body.slice(1)),
    result,
  };
}

function postForm(params: { port: number; body: string; signature: string }): Promise<HttpResult> {
  const req = request({
    host: "127.0.0.1",
    port: params.port,
    path: "/webhooks/sms",
    method: "POST",
    agent: false,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "content-length": Buffer.byteLength(params.body),
      "x-twilio-signature": params.signature,
    },
  });
  const result = readResponse(req);
  req.end(params.body);
  return result;
}

function sendIncompleteRawPost(
  port: number,
): Promise<{ response: string; endedByServer: boolean }> {
  return new Promise((resolve, reject) => {
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

function computeTwilioSignature(params: {
  account: ResolvedSmsAccount;
  form: Record<string, string>;
}): string {
  const input =
    params.account.publicWebhookUrl +
    Object.keys(params.form)
      .toSorted()
      .map((key) => `${key}${params.form[key] ?? ""}`)
      .join("");
  return createHmac("sha1", params.account.authToken).update(input).digest("base64");
}

describe("SMS webhook real route boundary", () => {
  afterEach(() => {
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    startSmsIngress.mockClear();
    pauseSmsIngress.mockClear();
    stopSmsIngress.mockClear();
    createSmsIngressSpool.mockClear();
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

    let receivedRequests = 0;
    let heldBodyReaders = 0;
    const handler: RequestListener = (req, res) => {
      receivedRequests += 1;
      const requestNumber = receivedRequests;
      if (requestNumber <= 64) {
        req.once("data", () => {
          heldBodyReaders += 1;
        });
      }
      void Promise.resolve(route.handler(req, res)).catch((error: unknown) => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end(error instanceof Error ? error.message : String(error));
        }
      });
    };
    const held: HeldRequest[] = [];

    try {
      await withServer(handler, async (baseUrl) => {
        const port = Number(new URL(baseUrl).port);
        try {
          for (let index = 0; index < 64; index += 1) {
            held.push(holdIncompletePost(port, index));
          }
          await vi.waitFor(
            () => {
              expect(receivedRequests).toBe(64);
              expect(heldBodyReaders).toBe(64);
            },
            { timeout: 10_000 },
          );

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
          expect(released.every((result) => result.statusCode === 403)).toBe(true);

          const form = {
            AccountSid: account.accountSid,
            From: "+15551234567",
            To: account.fromNumber,
            Body: "boundary proof",
            MessageSid: "SM00000000000000000000000000000985",
          };
          const body = new URLSearchParams(form).toString();
          const admitted = await postForm({
            port,
            body,
            signature: computeTwilioSignature({ account, form }),
          });

          expect(admitted.statusCode).toBe(200);
          expect(admitted.headers["x-openclaw-delivery-accepted"]).toBe("durable");
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
});

describe("createSmsWebhookHandler over a real connection", () => {
  beforeEach(() => {
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    advanceSmsTestAccountId();
  });

  it("delivers HTTP 413 over the wire and closes for an oversized callback body", async () => {
    const delivery = createSmsTestDeliveryRecorder();
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createSmsTestAccount(),
      ingress: { enqueue: enqueueSmsIngress },
      delivery,
    });
    await withServer(
      (req, res) => {
        void handler(req, res);
      },
      async (baseUrl) => {
        // Declared and sent in one write: the shape whose rejection used to race the flush.
        const result = await postRawWebhook({
          url: `${baseUrl}/sms`,
          body: "x".repeat(32 * 1024 + 1),
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": "unused",
          },
        });

        expect(result.statusLine).toBe("HTTP/1.1 413 Payload Too Large");
        expect(result.headers.connection).toBe("close");
        expect(result.body).toBe("Payload too large");
        expect(result.closedByServer).toBe(true);
        expect(delivery.record).not.toHaveBeenCalled();
        expect(enqueueSmsIngress).not.toHaveBeenCalled();
      },
    );
  });

  it("delivers a retryable 500 before closing a timed-out callback upload", async () => {
    const handler = createSmsWebhookHandler({
      cfg: {},
      account: createSmsTestAccount(),
      ingress: { enqueue: enqueueSmsIngress },
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
        // Observe after the body reader is installed; Bun's socket wrapper omits raw data events.
        req.once("data", () => requestReceived.resolve());
      },
      async (baseUrl) => {
        vi.useFakeTimers();
        try {
          const resultPromise = postRawWebhook({
            url: `${baseUrl}/sms`,
            body: "x",
            contentLength: 2,
            idleTimeoutMs: 10_000,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": "unused",
            },
          });

          await requestReceived.promise;
          await vi.advanceTimersByTimeAsync(6_000);
          const result = await resultPromise;

          expect(routeError).toBeUndefined();
          expect(result.statusLine).toBe("HTTP/1.1 500 Internal Server Error");
          expect(result.headers.connection).toBe("close");
          expect(result.body).toBe("Internal Server Error");
          expect(result.closedByServer).toBe(true);
          expect(enqueueSmsIngress).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });
});
