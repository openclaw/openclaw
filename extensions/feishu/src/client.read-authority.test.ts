import { AsyncLocalStorage } from "node:async_hooks";
import { Console } from "node:console";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { text } from "node:stream/consumers";
import { setImmediate } from "node:timers/promises";
import * as Lark from "@larksuiteoapi/node-sdk";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFeishuClient,
  resetFeishuProxyAgentForTest,
  type FeishuClientCredentials,
} from "./client.js";

const { captureReadAuthority, resolveProxy } = vi.hoisted(() => ({
  captureReadAuthority: vi.fn<() => (() => void) | undefined>(),
  resolveProxy: vi.fn<() => Promise<undefined>>(),
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return { ...actual, captureChannelReadAuthority: captureReadAuthority };
});

vi.mock("openclaw/plugin-sdk/extension-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/extension-shared")>();
  return { ...actual, resolveAmbientNodeProxyAgent: resolveProxy };
});

const AUTH_PATH = "/open-apis/auth/v3/tenant_access_token/internal";
const MESSAGE_PATH = "/open-apis/im/v1/messages";
const CLOSED_READ = "Feishu read authority closed";
const authority = new AsyncLocalStorage<() => void>();
const http = Lark.defaultHttpInstance;
type RequestTransform = Exclude<NonNullable<typeof http.defaults.transformRequest>, unknown[]>;
type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

function createReadScope() {
  let open = true;
  const assertCurrent = () => {
    if (!open) {
      throw new Error(CLOSED_READ);
    }
  };
  return {
    run<T>(operation: () => T): T {
      return authority.run(assertCurrent, operation);
    },
    close() {
      open = false;
    },
  };
}

describe("Feishu read authority over the real Lark SDK transport", () => {
  let server: ReturnType<typeof createServer>;
  let client: Lark.Client;
  let credentials: FeishuClientCredentials;
  let token: string;
  let requests: RecordedRequest[];
  let pendingRequests: Promise<unknown>[];
  let interceptors: number[];
  let releases: Array<() => void>;
  let handleRequest: (req: RecordedRequest, res: ServerResponse) => boolean | Promise<boolean>;
  let defaultTransforms: typeof http.defaults.transformRequest;
  let defaultBeforeRedirect: typeof http.defaults.beforeRedirect;

  function gate() {
    const pending = createDeferred<void>();
    releases.push(() => pending.resolve());
    return pending;
  }

  function read(messageId: string, from = client) {
    return track(from.im.message.get({ path: { message_id: messageId } }));
  }

  function track<T>(request: Promise<T>): Promise<T> {
    pendingRequests.push(request);
    return request;
  }

  const paths = () => requests.map(({ path }) => path);
  const methods = () => requests.map(({ method, path }) => `${method} ${path}`);
  function redirect(from: string, to: string) {
    handleRequest = (request, response) => {
      if (request.path !== from) {
        return false;
      }
      response.writeHead(307, { location: to });
      response.end();
      return true;
    };
  }

  beforeEach(async () => {
    // The scope fixture supplies request lifetime; host admission and result
    // settlement remain separate integration proof.
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
    captureReadAuthority.mockImplementation(() => authority.getStore());
    resolveProxy.mockResolvedValue(undefined);
    resetFeishuProxyAgentForTest();
    requests = [];
    pendingRequests = [];
    interceptors = [];
    releases = [];
    handleRequest = () => false;
    defaultTransforms = http.defaults.transformRequest;
    defaultBeforeRedirect = http.defaults.beforeRedirect;
    const accountId = `read-authority-${randomUUID()}`;
    credentials = {
      accountId,
      appId: `cli_${accountId}`,
      appSecret: "loopback-placeholder", // pragma: allowlist secret
      domain: "feishu",
    };
    token = `tat_${accountId}`;

    server = createServer((request, response) => {
      const reply = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      void (async () => {
        const rawBody = await text(request);
        const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
        const record: RecordedRequest = {
          method: request.method ?? "",
          path: new URL(request.url ?? "/", "http://127.0.0.1").pathname,
          headers: request.headers,
          body,
        };
        requests.push(record);
        if (await handleRequest(record, response)) {
          return;
        }
        if (record.path === AUTH_PATH) {
          if (
            record.method !== "POST" ||
            body?.app_id !== credentials.appId ||
            body?.app_secret !== credentials.appSecret
          ) {
            reply({ code: 99991663, msg: "invalid loopback application" }, 401);
            return;
          }
          reply({ code: 0, tenant_access_token: token, expire: 7200 });
          return;
        }
        if (record.headers.authorization !== `Bearer ${token}`) {
          reply({ code: 99991663, msg: "missing loopback authentication" }, 401);
          return;
        }
        reply({ code: 0, data: { message_id: "om_result", items: [] } });
      })().catch((error: unknown) => reply({ error: String(error) }, 500));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a loopback TCP listener");
    }
    const origin = `http://127.0.0.1:${address.port}`;
    interceptors.push(
      http.interceptors.request.use(
        (options) => {
          const upstream = new URL(options.url ?? "");
          if (upstream.origin === "https://open.feishu.cn") {
            options.url = new URL(`${upstream.pathname}${upstream.search}`, origin).toString();
            options.proxy = false;
          }
          return options;
        },
        undefined,
        { synchronous: true },
      ),
    );
    client = createFeishuClient(credentials);
  });

  afterEach(async () => {
    releases.forEach((release) => release());
    await Promise.allSettled(pendingRequests);
    interceptors.forEach((interceptor) => http.interceptors.request.eject(interceptor));
    http.defaults.transformRequest = defaultTransforms;
    http.defaults.beforeRedirect = defaultBeforeRedirect;
    resetFeishuProxyAgentForTest();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    captureReadAuthority.mockReset();
    resolveProxy.mockReset();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    authority.disable();
    vi.doUnmock("openclaw/plugin-sdk/fetch-runtime");
    vi.doUnmock("openclaw/plugin-sdk/extension-shared");
    vi.resetModules();
  });

  it("keeps concurrent reads independent while sharing pending proxy preparation", async () => {
    const proxyStarted = gate();
    const releaseProxy = gate();
    resolveProxy.mockImplementationOnce(async () => {
      proxyStarted.resolve();
      await releaseProxy.promise;
      return undefined;
    });
    const expired = createReadScope();
    const current = createReadScope();
    const expiredRead = expired.run(() => read("om_expired"));
    await proxyStarted.promise;
    const currentRead = current.run(() => read("om_current"));
    const outcomes = Promise.allSettled([expiredRead, currentRead]);
    // Drain the SDK's fulfilled cache promises so both reads reach the held proxy promise.
    await setImmediate();
    expect(requests).toEqual([]);
    expired.close();
    releaseProxy.resolve();

    expect(await outcomes).toMatchObject([
      { status: "rejected", reason: { message: CLOSED_READ } },
      { status: "fulfilled", value: { code: 0 } },
    ]);
    expect(paths()).toEqual([AUTH_PATH, `${MESSAGE_PATH}/om_current`]);
  });

  it.each([false, true])(
    "blocks HTTP after an async Axios interceptor closes a read (cached token: %s)",
    async (cachedToken) => {
      if (cachedToken) {
        await read("om_warmup");
        requests.length = 0;
      }
      const intercepted = gate();
      const releaseInterceptor = gate();
      const heldPath = cachedToken ? `${MESSAGE_PATH}/om_interceptor` : AUTH_PATH;
      interceptors.push(
        http.interceptors.request.use(async (options) => {
          if (new URL(options.url ?? "").pathname === heldPath) {
            intercepted.resolve();
            await releaseInterceptor.promise;
          }
          return options;
        }),
      );
      const scope = createReadScope();
      const rejected = expect(scope.run(() => read("om_interceptor"))).rejects.toThrow(CLOSED_READ);
      await intercepted.promise;
      scope.close();
      releaseInterceptor.resolve();

      await rejected;
      expect(requests).toEqual([]);
    },
  );

  it("fences the data request after cold auth without poisoning later reads or ordinary writes", async () => {
    const authStarted = gate();
    const releaseAuth = gate();
    handleRequest = async (request) => {
      if (request.path === AUTH_PATH) {
        authStarted.resolve();
        await releaseAuth.promise;
      }
      return false;
    };
    const expired = createReadScope();
    const rejected = expect(expired.run(() => read("om_expired"))).rejects.toThrow(CLOSED_READ);
    await authStarted.promise;
    expired.close();
    releaseAuth.resolve();
    await rejected;
    expect(paths()).toEqual([AUTH_PATH]);

    const fresh = createReadScope();
    await expect(
      fresh.run(() => read("om_fresh", createFeishuClient(credentials))),
    ).resolves.toMatchObject({ code: 0 });
    fresh.close();
    const writing = client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_loopback",
        msg_type: "text",
        content: JSON.stringify({ text: "ordinary write" }),
      },
    });
    await expect(track(writing)).resolves.toMatchObject({ code: 0 });
    expect(methods()).toEqual([
      `POST ${AUTH_PATH}`,
      `GET ${MESSAGE_PATH}/om_fresh`,
      `POST ${MESSAGE_PATH}`,
    ]);
  });

  it("keeps credentials out of default diagnostics when a cold auth redirect closes the read", async () => {
    const scope = createReadScope();
    let diagnostics = "";
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        diagnostics += chunk.toString();
        callback();
      },
    });
    // Keep Node's default console formatting, including its normal inspection depth.
    const capturedConsole = new Console({ stdout: output, stderr: output });
    const log = vi
      .spyOn(console, "log")
      .mockImplementation(capturedConsole.log.bind(capturedConsole));
    try {
      http.defaults.beforeRedirect = () => scope.close();
      redirect(AUTH_PATH, `${AUTH_PATH}/redirected`);

      await expect(scope.run(() => read("om_auth_redirect"))).rejects.toThrow(CLOSED_READ);
      expect(methods()).toEqual([`POST ${AUTH_PATH}`]);
      expect(diagnostics).toContain(CLOSED_READ);
      expect(diagnostics).not.toContain(credentials.appSecret);
      expect(diagnostics).not.toContain(token);
    } finally {
      log.mockRestore();
      output.destroy();
    }
  });

  it.each([false, true])(
    "preserves request transforms and redirect callbacks (close in request callback: %s)",
    async (closeOnRedirect) => {
      const scope = createReadScope();
      const addDefaultHeader: RequestTransform = (data: unknown, headers) => {
        headers.set("X-Default-Transform", "preserved");
        return data;
      };
      const transforms = defaultTransforms
        ? Array.isArray(defaultTransforms)
          ? defaultTransforms
          : [defaultTransforms]
        : [];
      http.defaults.transformRequest = [...transforms, addDefaultHeader];
      http.defaults.beforeRedirect = (options) => {
        options.headers["X-Redirect-Callback"] = "default";
      };
      redirect(`${MESSAGE_PATH}/om_redirect`, `${MESSAGE_PATH}/om_destination`);
      const result = track(
        scope.run(() =>
          client.request({
            method: "GET",
            url: `${MESSAGE_PATH}/om_redirect`,
            data: { read: "payload" },
            transformRequest: [
              (data: unknown, headers) => {
                headers.set("X-Request-Transform", "preserved");
                return JSON.stringify({ payload: data });
              },
            ],
            ...(closeOnRedirect ? { beforeRedirect: () => scope.close() } : {}),
          }),
        ),
      );
      if (closeOnRedirect) {
        await expect(result).rejects.toThrow(CLOSED_READ);
      } else {
        await expect(result).resolves.toMatchObject({ code: 0 });
      }

      expect(paths()).toEqual([
        AUTH_PATH,
        `${MESSAGE_PATH}/om_redirect`,
        ...(closeOnRedirect ? [] : [`${MESSAGE_PATH}/om_destination`]),
      ]);
      expect(requests[0]?.headers["x-default-transform"]).toBe("preserved");
      for (const request of requests.slice(1)) {
        expect(request.body).toEqual({ payload: { read: "payload" } });
        expect(request.headers["x-request-transform"]).toBe("preserved");
        expect(request.headers["x-default-transform"]).toBeUndefined();
      }
      if (!closeOnRedirect) {
        expect(requests.at(-1)?.headers["x-redirect-callback"]).toBe("default");
      }
    },
  );
});
