import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import { createConnection, type Socket } from "node:net";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createFixtureLifetime, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import type { ResolvedSmsAccount } from "./types.js";
import { createSmsTestAccount, computeSmsTestTwilioSignature } from "./webhook.test-support.js";

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

type BoundaryIo = {
  signal: AbortSignal;
  own: (handle: ClientRequest | Socket) => void;
  track: <T>(completion: Promise<T>) => Promise<T>;
};

function createAccount(): ResolvedSmsAccount {
  return createSmsTestAccount({ accountId: "boundary" });
}

function readResponse(req: ClientRequest): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    req.once("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.once("error", reject);
      res.once("aborted", () => reject(new Error("SMS response aborted")));
      res.once("end", () => {
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.once("error", reject);
    req.once("close", () => reject(new Error("SMS request closed before its response completed")));
  });
}

function holdIncompletePost(port: number, index: number, io: BoundaryIo): HeldRequest {
  io.signal.throwIfAborted();
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
  io.own(req);
  req.once("socket", io.own);
  const result = io.track(readResponse(req));
  req.write(body.slice(0, 1));
  return {
    request: req,
    finish: () => {
      io.signal.throwIfAborted();
      req.end(body.slice(1));
    },
    result,
  };
}

function postForm(
  params: { port: number; body: string; signature: string },
  io: BoundaryIo,
): Promise<HttpResult> {
  io.signal.throwIfAborted();
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
  io.own(req);
  req.once("socket", io.own);
  const result = io.track(readResponse(req));
  req.end(params.body);
  return result;
}

function sendIncompleteRawPost(
  port: number,
  io: BoundaryIo,
): Promise<{ response: string; endedByServer: boolean }> {
  io.signal.throwIfAborted();
  return io.track(
    new Promise((resolve, reject) => {
      const socket = createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
      io.own(socket);
      const chunks: Buffer[] = [];
      let endedByServer = false;
      socket.once("connect", () => {
        if (io.signal.aborted) {
          return;
        }
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

describe("SMS webhook real route boundary", () => {
  let finishHeldCase: (() => Promise<void>) | undefined;
  afterEach(async () => {
    const finish = finishHeldCase;
    finishHeldCase = undefined;
    await finish?.();
    enqueueSmsIngress.mockReset();
    enqueueSmsIngress.mockResolvedValue({ kind: "accepted", duplicate: false });
    startSmsIngress.mockClear();
    pauseSmsIngress.mockClear();
    stopSmsIngress.mockClear();
    createSmsIngressSpool.mockClear();
  });

  it("closes overflow uploads and recovers capacity for a signed callback", async () => {
    const lifetime = createFixtureLifetime();
    const abortController = new AbortController();
    const handles = new Set<ClientRequest | Socket>();
    const closes: Promise<void>[] = [];
    const handlers: Promise<unknown>[] = [];
    const io: BoundaryIo = {
      signal: abortController.signal,
      track: lifetime.track,
      own(handle) {
        if (handles.has(handle)) {
          return;
        }
        handles.add(handle);
        closes.push(
          lifetime.track(
            new Promise<void>((resolve) => {
              handle.once("close", () => {
                handles.delete(handle);
                resolve();
              });
            }),
          ),
        );
        // Socket assignment can arrive after timeout teardown's initial sweep.
        if (abortController.signal.aborted) {
          handle.destroy();
        }
      },
    };
    const releaseIo = () => {
      abortController.abort();
      for (const handle of handles) {
        handle.destroy();
      }
    };
    let finishing: Promise<void> | undefined;
    const finishCase = () => {
      releaseIo();
      return (finishing ??= lifetime.cleanup());
    };
    finishHeldCase = finishCase;
    const scenario = lifetime.run(async () => {
      const account = createAccount();
      const registry = createEmptyPluginRegistry();
      const previousRegistry = getActivePluginRegistry();
      let lifecycle: Promise<unknown> | undefined;
      setActivePluginRegistry(registry);
      try {
        abortController.signal.throwIfAborted();
        lifecycle = lifetime.track(
          startSmsGatewayAccount({
            cfg: {},
            account,
            channelRuntime: {} as SmsChannelRuntime,
            abortSignal: abortController.signal,
          }),
          true,
        );
        await vi.waitFor(() => expect(registry.httpRoutes).toHaveLength(1));
        const route = registry.httpRoutes[0];
        if (!route) {
          throw new Error("expected the SMS gateway to register its account route");
        }
        let receivedRequests = 0;
        let heldBodyReaders = 0;
        const handler: RequestListener = (req, res) => {
          io.own(req.socket);
          if (abortController.signal.aborted) {
            res.destroy();
            return;
          }
          receivedRequests += 1;
          const requestNumber = receivedRequests;
          if (requestNumber <= 64) {
            req.once("data", () => {
              heldBodyReaders += 1;
            });
          }
          const handling = lifetime.track(Promise.resolve(route.handler(req, res)));
          handlers.push(handling);
          void handling.catch((error: unknown) => {
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end(error instanceof Error ? error.message : String(error));
            }
          });
        };
        const held: HeldRequest[] = [];
        abortController.signal.throwIfAborted();
        let callbackFailure: { error: unknown } | undefined;
        try {
          await lifetime.track(
            withServer(handler, async (baseUrl) => {
              const port = Number(new URL(baseUrl).port);
              try {
                for (let index = 0; index < 64; index += 1) {
                  held.push(holdIncompletePost(port, index, io));
                }
                await vi.waitFor(
                  () => {
                    expect(receivedRequests).toBe(64);
                    expect(heldBodyReaders).toBe(64);
                  },
                  { timeout: 10_000 },
                );

                // Header-only input plus peer closure proves early rejection; Bun marks req.complete on response end.
                const overflow = await sendIncompleteRawPost(port, io);
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
                const admitted = await postForm(
                  {
                    port,
                    body,
                    signature: computeSmsTestTwilioSignature({
                      url: account.publicWebhookUrl,
                      authToken: account.authToken,
                      form,
                    }),
                  },
                  io,
                );

                expect(admitted.statusCode).toBe(200);
                expect(admitted.headers["x-openclaw-delivery-accepted"]).toBe("durable");
                expect(enqueueSmsIngress).toHaveBeenCalledOnce();
                expect(enqueueSmsIngress).toHaveBeenCalledWith(form);
              } catch (error) {
                callbackFailure = { error };
                throw error;
              } finally {
                releaseIo();
                await Promise.allSettled(held.map((pending) => pending.result));
              }
            }),
          );
        } catch (error) {
          if (callbackFailure && !Object.is(callbackFailure.error, error)) {
            throw new AggregateError([callbackFailure.error, error], "SMS server cleanup failed", {
              cause: callbackFailure.error,
            });
          }
          throw error;
        }
      } finally {
        releaseIo();
        try {
          await Promise.allSettled([...handlers, ...closes, ...(lifecycle ? [lifecycle] : [])]);
        } finally {
          if (previousRegistry) {
            setActivePluginRegistry(previousRegistry);
          } else {
            resetPluginRuntimeStateForTest();
          }
        }
      }
    });
    let failure: { error: unknown } | undefined;
    try {
      await scenario;
    } catch (error) {
      failure = { error };
      throw error;
    } finally {
      try {
        await finishCase();
      } catch (cleanupError) {
        throw failure
          ? new AggregateError([failure.error, cleanupError], "SMS fixture cleanup failed", {
              cause: failure.error,
            })
          : cleanupError;
      }
    }
  });
});
