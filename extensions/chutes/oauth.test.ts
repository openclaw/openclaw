// Chutes tests cover oauth plugin behavior.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { loginChutes } from "./oauth.js";

const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";
const REDIRECT_URI = "http://127.0.0.1:1456/oauth-callback";

function boundedErrorResponse(
  body: string,
  status = 500,
): {
  response: Response;
  cancel: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  text: ReturnType<typeof vi.fn>;
} {
  const encoded = new TextEncoder().encode(body);
  let read = false;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("response.text() should not be called");
  });
  const response = {
    ok: false,
    status,
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          if (read) {
            return { done: true, value: undefined };
          }
          read = true;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
    text,
  } as unknown as Response;

  return { response, cancel, releaseLock, text };
}

function fetchInputUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function timeoutResult<T>(value: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), timeoutMs);
  });
}

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startHangingLoopbackServer(): Promise<{
  origin: string;
  requests: string[];
  waitForRequestCount: (count: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  type RequestWaiter = {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const waiters: RequestWaiter[] = [];

  const resolveWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || requests.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
    }
  };

  const server = createServer((req, _res) => {
    requests.push(req.url ?? "");
    req.resume();
    resolveWaiters();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    waitForRequestCount: async (count: number) => {
      if (requests.length >= count) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: RequestWaiter = {
          count,
          resolve,
          reject,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`server received ${requests.length} request(s), expected ${count}`));
        }, 500);
        waiters.push(waiter);
      });
    },
    close: async () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.reject(new Error("server closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function expectFetchWithoutDeadlineToStayPending(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const request = fetch(url, { ...init, signal: controller.signal });
  request.catch(() => undefined);

  const result = await Promise.race([
    request.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    timeoutResult("pending" as const, 30),
  ]);

  controller.abort();
  await request.catch(() => undefined);
  expect(result).toBe("pending");
}

async function loginOutcomeWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<
  | { status: "pending" }
  | { status: "resolved" }
  | {
      status: "rejected";
      error: unknown;
    }
> {
  return await Promise.race([
    promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    timeoutResult({ status: "pending" as const }, timeoutMs),
  ]);
}

function expectAbortOrTimeoutError(error: unknown) {
  expect(error).toHaveProperty("name", expect.stringMatching(/^(AbortError|TimeoutError)$/));
}

describe("chutes plugin OAuth", () => {
  it("rejects unsafe token lifetimes before storing credentials", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow("Chutes token exchange returned invalid expires_in");
  });

  it("bounds token exchange error bodies without requiring response.text()", async () => {
    const errorResponse = boundedErrorResponse(
      `${"chutes token unavailable ".repeat(1024)}tail-marker`,
      502,
    );
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/token") {
        return errorResponse.response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Chutes token exchange failed: chutes token unavailable");
    expect(message).not.toContain("tail-marker");
    expect(errorResponse.text).not.toHaveBeenCalled();
    expect(errorResponse.cancel).toHaveBeenCalledTimes(1);
    expect(errorResponse.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels oversized token exchange JSON body via the 16 MiB provider cap", async () => {
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32;
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const oversizedTokenJson = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (bytesPulled >= TOTAL_CHUNKS * ONE_MIB) {
            controller.close();
            return;
          }
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ login: "test", name: "Test" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://api.chutes.ai/idp/token") {
        return oversizedTokenJson;
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(
          async () => "http://127.0.0.1:1456/oauth-callback?code=code_test&state=state_test",
        ),
        fetchFn,
      }),
    ).rejects.toThrow(/Chutes token exchange: JSON response exceeds 16777216 bytes/);

    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });

  it("times out token exchange HTTP requests against a hanging loopback server", async () => {
    const server = await startHangingLoopbackServer();
    let loginPromise: Promise<unknown> | undefined;

    try {
      await expectFetchWithoutDeadlineToStayPending(`${server.origin}/control`, {
        method: "POST",
        body: "grant_type=authorization_code",
      });
      await server.waitForRequestCount(1);

      const fetchFn = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await fetch(`${server.origin}/token`, init),
      );
      loginPromise = loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: REDIRECT_URI,
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(async () => `${REDIRECT_URI}?code=code_test&state=state_test`),
        fetchFn,
        requestTimeoutMs: 50,
      });
      loginPromise.catch(() => undefined);

      await server.waitForRequestCount(2);
      const result = await loginOutcomeWithin(loginPromise, 500);
      if (result.status !== "rejected") {
        throw new Error(`expected token exchange to reject, got ${result.status}`);
      }
      expectAbortOrTimeoutError(result.error);
      expect(server.requests).toContain("/token");
    } finally {
      await server.close();
      await loginPromise?.catch(() => undefined);
    }
  });

  it("times out userinfo HTTP requests against a hanging loopback server", async () => {
    const server = await startHangingLoopbackServer();
    let loginPromise: Promise<unknown> | undefined;

    try {
      await expectFetchWithoutDeadlineToStayPending(`${server.origin}/control`);
      await server.waitForRequestCount(1);

      const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = fetchInputUrl(input);
        if (url === CHUTES_TOKEN_ENDPOINT) {
          return new Response(
            '{"access_token":"at_timeout","refresh_token":"rt_timeout","expires_in":3600}',
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url === CHUTES_USERINFO_ENDPOINT) {
          return await fetch(`${server.origin}/userinfo`, init);
        }
        return new Response("not found", { status: 404 });
      });
      loginPromise = loginChutes({
        app: {
          clientId: "cid_test",
          redirectUri: REDIRECT_URI,
          scopes: ["openid"],
        },
        manual: true,
        createState: () => "state_test",
        onAuth: vi.fn(async () => {}),
        onPrompt: vi.fn(async () => `${REDIRECT_URI}?code=code_test&state=state_test`),
        fetchFn,
        requestTimeoutMs: 50,
      });
      loginPromise.catch(() => undefined);

      await server.waitForRequestCount(2);
      const result = await loginOutcomeWithin(loginPromise, 500);
      if (result.status !== "rejected") {
        throw new Error(`expected userinfo fetch to reject, got ${result.status}`);
      }
      expectAbortOrTimeoutError(result.error);
      expect(server.requests).toContain("/userinfo");
    } finally {
      await server.close();
      await loginPromise?.catch(() => undefined);
    }
  });
});
