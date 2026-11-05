import { request, type ClientRequest, type RequestListener } from "node:http";
import { createConnection, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createFixtureLifetime, postRawWebhook, withServer } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import { createSmsWebhookHandler } from "./webhook.js";
import {
  advanceSmsTestAccountId,
  createSmsTestAccount,
  createSmsTestForm,
  createSmsTestDeliveryRecorder,
  signSmsTestForm,
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

const boundaryFixtures: Array<{ retire: () => void; drain: () => Promise<void> }> = [];

function createBoundaryFixture() {
  const lifetime = createFixtureLifetime();
  const retirement = new AbortController();
  const previousRegistry = getActivePluginRegistry();
  const requests = new Set<ClientRequest>();
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  let retired = false;
  let draining: Promise<void> | undefined;
  const retire = () => {
    if (retired) {
      return;
    }
    retired = true;
    for (const cancel of [
      () => retirement.abort(new Error("SMS boundary fixture retired")),
      ...[...requests].map((req) => () => req.destroy()),
      ...[...sockets].map((socket) => () => socket.destroy()),
    ]) {
      try {
        cancel();
      } catch (error) {
        failures.push(error);
      }
    }
  };
  const ownSocket = (socket: Socket) => {
    sockets.add(socket);
    void lifetime.track(
      new Promise<void>((resolve) => {
        socket.once("close", () => {
          sockets.delete(socket);
          resolve();
        });
      }),
    );
    // ClientRequest can assign its socket after teardown starts.
    if (retired) {
      socket.destroy();
    }
    return socket;
  };
  const ownRequest = (req: ClientRequest) => {
    requests.add(req);
    void lifetime.track(
      new Promise<void>((resolve) => {
        req.once("close", () => {
          requests.delete(req);
          resolve();
        });
      }),
    );
    req.once("socket", ownSocket);
    if (retired) {
      req.destroy();
    }
  };
  const drain = () =>
    (draining ??= (async () => {
      retire();
      try {
        await lifetime.cleanup();
      } catch (error) {
        failures.push(error);
      }
      // Restore the registry only after the original server callback, handlers,
      // client bodies and gateway lifecycle have all settled.
      try {
        if (previousRegistry) {
          setActivePluginRegistry(previousRegistry);
        } else {
          resetPluginRuntimeStateForTest();
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "SMS boundary fixture cleanup failed");
      }
    })());
  boundaryFixtures.push({ retire, drain });
  return {
    run: lifetime.run,
    track: lifetime.track,
    wait: <T>(work: Promise<T>) => withinTest(lifetime.track(work), retirement.signal),
    signal: retirement.signal,
    ownRequest,
    ownSocket,
  };
}

afterEach(async () => {
  const fixtures = boundaryFixtures.splice(0);
  for (const fixture of fixtures) {
    fixture.retire();
  }
  const results = await Promise.allSettled(fixtures.map((fixture) => fixture.drain()));
  vi.useRealTimers();
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length) {
    throw new AggregateError(failures, "SMS boundary teardown failed");
  }
});

function holdIncompletePost(
  port: number,
  index: number,
  fixture: ReturnType<typeof createBoundaryFixture>,
) {
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
  fixture.ownRequest(req);
  const result = fixture.track(
    new Promise<number>((resolve, reject) => {
      req.once("response", (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("error", reject);
        res.once("aborted", () => reject(new Error("SMS response aborted")));
      });
      req.once("error", reject);
      req.once("close", () => reject(new Error("SMS request closed before response end")));
    }),
  );
  req.write(body.slice(0, 1));
  return {
    request: req,
    finish: () => req.end(body.slice(1)),
    result,
  };
}

function sendIncompleteRawPost(port: number, fixture: ReturnType<typeof createBoundaryFixture>) {
  return fixture.track(
    new Promise<{ response: string; endedByServer: boolean }>((resolve, reject) => {
      const socket = fixture.ownSocket(
        createConnection({ host: "127.0.0.1", port, allowHalfOpen: true }),
      );
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
    }),
  );
}

beforeEach(() => {
  enqueueSmsIngress.mockReset();
  enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
  advanceSmsTestAccountId();
});

it("closes overflow uploads and recovers capacity for a signed callback", () => {
  const fixture = createBoundaryFixture();
  return fixture.run(async () => {
    const account = createSmsTestAccount({ accountId: "boundary" });
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
    void fixture.track(
      startSmsGatewayAccount({
        cfg: {},
        account,
        channelRuntime: {} as SmsChannelRuntime,
        abortSignal: fixture.signal,
      }),
      true,
    );
    await fixture.wait(vi.waitFor(() => expect(registry.httpRoutes).toHaveLength(1)));
    fixture.signal.throwIfAborted();
    const route = registry.httpRoutes[0];
    if (!route) {
      throw new Error("expected the SMS gateway to register its account route");
    }

    const received = { requests: 0, bodyReaders: 0 };
    const capacityReady = createDeferred<void>();
    const handler: RequestListener = (req, res) => {
      received.requests += 1;
      if (received.requests <= 64) {
        req.once("data", () => {
          received.bodyReaders += 1;
          if (received.bodyReaders === 64) {
            capacityReady.resolve();
          }
        });
      }
      void fixture.track(
        fixture.track(Promise.resolve(route.handler(req, res))).catch((error: unknown) => {
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end(error instanceof Error ? error.message : String(error));
          }
        }),
      );
    };
    const held: ReturnType<typeof holdIncompletePost>[] = [];

    let callbackFailure: { error: unknown } | undefined;
    const server = withServer(handler, async (baseUrl) => {
      try {
        fixture.signal.throwIfAborted();
        const port = Number(new URL(baseUrl).port);
        for (let index = 0; index < 64; index += 1) {
          held.push(holdIncompletePost(port, index, fixture));
        }
        await withinTest(capacityReady.promise, fixture.signal);
        expect(received).toEqual({ requests: 64, bodyReaders: 64 });

        // Header-only input plus peer closure proves early rejection; Bun marks req.complete on response end.
        const overflow = await fixture.wait(sendIncompleteRawPost(port, fixture));
        expect(overflow.response).toContain("HTTP/1.1 429 Too Many Requests\r\n");
        expect(overflow.response).toMatch(/\r\nConnection: close\r\n/iu);
        expect(overflow.response).toContain("\r\n\r\nRate limit exceeded");
        expect(overflow.endedByServer).toBe(true);
        expect(enqueueSmsIngress).not.toHaveBeenCalled();

        for (const pending of held) {
          pending.finish();
        }
        const released = await fixture.wait(Promise.all(held.map((pending) => pending.result)));
        expect(released.every((statusCode) => statusCode === 403)).toBe(true);

        const form: Record<string, string> = createSmsTestForm(
          { Body: "boundary proof", MessageSid: "SM00000000000000000000000000000985" },
          account,
        );
        const { body, signature } = signSmsTestForm(form, account);
        const admitted = await fixture.wait(
          (async () => {
            const response = await fetch(`${baseUrl}/webhooks/sms`, {
              signal: fixture.signal,
              method: "POST",
              body,
              headers: {
                "content-type": "application/x-www-form-urlencoded",
                "x-twilio-signature": signature,
              },
            });
            await response.text();
            return response;
          })(),
        );

        expect(admitted.status).toBe(200);
        expect(admitted.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
        expect(enqueueSmsIngress).toHaveBeenCalledOnce();
        expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
      } catch (error) {
        callbackFailure = { error };
        throw error;
      } finally {
        for (const pending of held) {
          pending.request.destroy();
        }
        await Promise.allSettled(held.map((pending) => pending.result));
      }
    });
    // Cancellation can finish the test before server.close rejects. Report that
    // cleanup failure without duplicating the callback's original test error.
    void fixture.track(
      server.catch((error: unknown) => {
        if (!callbackFailure || !Object.is(error, callbackFailure.error)) {
          throw error;
        }
      }),
      true,
    );
    await fixture.wait(server);
  });
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
