// Msteams tests cover monitor.lifecycle plugin behavior.
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsPollStore } from "./polls.js";

type FakeServer = EventEmitter & {
  close: (callback?: (err?: Error | null) => void) => void;
  setTimeout: (msecs: number) => FakeServer;
  requestTimeout: number;
  headersTimeout: number;
};

type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
};

type ResolveMSTeamsTeamsConfigMock = (params: {
  cfg: unknown;
  teamIdMode: "bot-framework" | "graph";
  teams: Record<string, unknown>;
}) => Promise<{
  teams: Record<string, unknown>;
  mapping: string[];
  unresolved: string[];
}>;

type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;

type RegisterMSTeamsHandlersMock = (
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
) => MSTeamsActivityHandler;

type MockExpressFn = ReturnType<typeof vi.fn>;
type MockExpressApp = MockExpressFn & {
  use: MockExpressFn;
  post: MockExpressFn;
  listen: MockExpressFn;
};

const expressControl = vi.hoisted(() => ({
  mode: { value: "listening" as "listening" | "error" },
  apps: [] as MockExpressApp[],
}));

const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", () => ({
  DEFAULT_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  isDangerousNameMatchingEnabled,
  normalizeSecretInputString: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  hasConfiguredSecretInput: (value: unknown) =>
    typeof value === "string" && value.trim().length > 0,
  normalizeResolvedSecretInputString: (params: { value?: unknown }) =>
    typeof params?.value === "string" && params.value.trim() ? params.value.trim() : undefined,
  keepHttpServerTaskAlive: vi.fn(
    async (params: { abortSignal?: AbortSignal; onAbort?: () => Promise<void> | void }) => {
      await new Promise<void>((resolve) => {
        if (params.abortSignal?.aborted) {
          resolve();
          return;
        }
        params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await params.onAbort?.();
    },
  ),
  mergeAllowlist: (params: { existing?: string[]; additions?: string[] }) =>
    Array.from(new Set([...(params.existing ?? []), ...(params.additions ?? [])])),
  summarizeMapping: vi.fn(),
}));

vi.mock("express", () => {
  const json = vi.fn(() => {
    return (_req: unknown, _res: unknown, next?: (err?: unknown) => void) => {
      next?.();
    };
  });

  const factory = () => {
    const app = vi.fn() as MockExpressApp;
    app.use = vi.fn();
    app.post = vi.fn();
    app.listen = vi.fn((_port: number) => {
      const server = new EventEmitter() as FakeServer;
      server.setTimeout = vi.fn((_msecs: number) => server);
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.close = (callback?: (err?: Error | null) => void) => {
        queueMicrotask(() => {
          server.emit("close");
          callback?.(null);
        });
      };
      queueMicrotask(() => {
        if (expressControl.mode.value === "error") {
          server.emit("error", new Error("listen EADDRINUSE"));
          return;
        }
        server.emit("listening");
      });
      return server;
    });
    return app;
  };

  const wrappedFactory = () => {
    const app = factory();
    expressControl.apps.push(app);
    return app;
  };

  return {
    default: wrappedFactory,
    json,
  };
});

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn<RegisterMSTeamsHandlersMock>((handler) => handler),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, options?: unknown) => {
    const cloud = (options as { cloud?: string } | undefined)?.cloud;
    const tokenServiceUrl =
      cloud === "USGov"
        ? "https://tokengcch.botframework.azure.us"
        : cloud === "USGovDoD"
          ? "https://apiDoD.botframework.azure.us"
          : cloud === "China"
            ? "https://token.botframework.azure.cn"
            : "https://token.botframework.com";
    return {
      app: {
        on: vi.fn(),
        event: vi.fn(),
        onTokenExchange: vi.fn(async () => ({ status: 200 })),
        onVerifyState: vi.fn(async () => ({ status: 200 })),
        initialize: vi.fn(async () => {}),
        cloud: { tokenServiceUrl },
        tokenManager: {
          getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
          getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
        },
      },
    };
  }),
);

const ssoTokenStore = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => false),
}));

vi.mock("@microsoft/teams.apps", () => ({
  ExpressAdapter: vi.fn(),
}));

vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized,
  isSigninInvokeAuthorized,
  registerMSTeamsHandlers,
}));

vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler,
}));

const resolveAllowlistMocks = vi.hoisted(() => ({
  resolveMSTeamsTeamsConfig: vi.fn<ResolveMSTeamsTeamsConfigMock>(async ({ teams }) => ({
    teams,
    mapping: [],
    unresolved: [],
  })),
  resolveMSTeamsUserAllowlist: vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
}));

vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsTeamsConfig: resolveAllowlistMocks.resolveMSTeamsTeamsConfig,
  resolveMSTeamsUserAllowlist: resolveAllowlistMocks.resolveMSTeamsUserAllowlist,
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: unknown) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createMSTeamsExpressAdapter: vi.fn().mockResolvedValue({
    registerRoute: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("./runtime.js", () => ({
  getMSTeamsRuntime: () => ({
    logging: {
      getChildLogger: () => ({
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      }),
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
      },
    },
  }),
}));

vi.mock("./sso-token-store.js", () => ({
  createMSTeamsSsoTokenStoreFs: () => ssoTokenStore,
}));

import { monitorMSTeamsProvider } from "./monitor.js";

function createConfig(port: number): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        webhook: {
          port,
          path: "/api/messages",
        },
      },
    },
  } as OpenClawConfig;
}

function updateMSTeamsConfig(
  cfg: OpenClawConfig,
  patch: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): void {
  const msteams = cfg.channels?.msteams;
  if (!cfg.channels || !msteams) {
    throw new Error("Expected Microsoft Teams config fixture");
  }
  cfg.channels.msteams = {
    ...msteams,
    ...patch,
  };
}

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

function createStores() {
  return {
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  };
}

async function getLoadedMSTeamsApp() {
  const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
  if (!sdkResultPromise) {
    throw new Error("expected loadMSTeamsSdkWithAuth result");
  }
  return (await sdkResultPromise).app;
}

async function getRegisteredMSTeamsRoute(
  name: string,
): Promise<(ctx: unknown) => Promise<unknown>> {
  const app = await getLoadedMSTeamsApp();
  const route = app.on.mock.calls.find((call: [string, unknown]) => call[0] === name)?.[1];
  if (typeof route !== "function") {
    throw new Error(`expected ${name} handler`);
  }
  return route as (ctx: unknown) => Promise<unknown>;
}

function createJsonResponse(body: unknown, status = 200): globalThis.Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function getFetchInputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function createOversizedResponse(): globalThis.Response {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  let sent = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 272) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1] as
    | { cfg?: OpenClawConfig }
    | undefined;
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

describe("monitorMSTeamsProvider lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    expressControl.mode.value = "listening";
    expressControl.apps.length = 0;
    isDangerousNameMatchingEnabled.mockReset().mockReturnValue(false);
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig
      .mockReset()
      .mockImplementation(async ({ teams }) => ({ teams, mapping: [], unresolved: [] }));
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
    isSigninInvokeAuthorized.mockReset().mockResolvedValue(true);
    isCardActionInvokeAuthorized.mockReset().mockResolvedValue(true);
    vi.unstubAllGlobals();
    runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
    ssoTokenStore.get.mockClear();
    ssoTokenStore.save.mockClear();
    ssoTokenStore.remove.mockClear();
  });

  it("stays active until aborted", async () => {
    const abort = new AbortController();
    const stores = createStores();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: stores.conversationStore,
      pollStore: stores.pollStore,
    });

    const early = await Promise.race([
      task.then(() => "resolved"),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 50);
      }),
    ]);
    expect(early).toBe("pending");

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected Teams monitor app after startup abort");
    }
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("rejects startup when webhook port is already in use", async () => {
    expressControl.mode.value = "error";
    await expect(
      monitorMSTeamsProvider({
        cfg: createConfig(3978),
        runtime: createRuntime(),
        abortSignal: new AbortController().signal,
        conversationStore: createStores().conversationStore,
        pollStore: createStores().pollStore,
      }),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it("rejects requests without Bearer token before SDK route", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(expressControl.apps.length).toBeGreaterThan(0);
    });

    const app = expressControl.apps.at(-1);
    expect(app).toBeDefined();
    // Three middlewares are installed before the SDK route registers:
    // [0] = bearer-presence gate — rejects unauthenticated requests cheaply.
    // [1] = `express.json({ limit })` — caps bearer-shaped inbound bodies
    //       before the SDK's later json() can parse them.
    // [2] = JSON parser error handler — keeps 413 responses JSON-shaped.
    expect(app!.use.mock.calls.length).toBeGreaterThanOrEqual(3);

    const bearerMiddleware = app!.use.mock.calls[0]?.[0] as (
      req: Request,
      res: Response,
      next: (err?: unknown) => void,
    ) => void;

    // Request without Bearer token should be rejected
    const statusFn = vi.fn().mockReturnValue({ json: vi.fn() });
    const next = vi.fn();
    bearerMiddleware({ headers: {} } as Request, { status: statusFn } as unknown as Response, next);
    expect(statusFn).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();

    // Request with Bearer token should pass through
    const next2 = vi.fn();
    bearerMiddleware(
      { headers: { authorization: "Bearer valid-token" } } as Request,
      {} as Response,
      next2,
    );
    expect(next2).toHaveBeenCalledTimes(1);

    abort.abort();
    await task;
  });

  it("keeps oversized webhook parse failures JSON-shaped", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(expressControl.apps.length).toBeGreaterThan(0);
    });

    const app = expressControl.apps.at(-1);
    const jsonErrorMiddleware = app!.use.mock.calls[2]?.[0] as (
      err: unknown,
      req: Request,
      res: Response,
      next: (err?: unknown) => void,
    ) => void;
    const json = vi.fn();
    const status = vi.fn(() => ({ json }));
    const next = vi.fn();

    jsonErrorMiddleware({ status: 413 }, {} as Request, { status } as unknown as Response, next);

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ error: "Payload too large" });
    expect(next).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("forwards legacy /api/messages requests to a custom webhook path", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      webhook: { port: 0, path: "/teams/events" },
    });
    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(expressControl.apps.length).toBeGreaterThan(0);
    });

    const app = expressControl.apps.at(-1);
    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      messagingEndpoint: "/teams/events",
    });
    const legacyForwarder = app!.post.mock.calls.find((call) => call[0] === "/api/messages")?.[1];
    expect(typeof legacyForwarder).toBe("function");
    if (typeof legacyForwarder !== "function") {
      throw new Error("expected legacy /api/messages forwarder");
    }

    const req = { url: "/api/messages", headers: { authorization: "Bearer valid" } } as Request;
    const res = {} as Response;
    const next = vi.fn();
    legacyForwarder(req, res, next);

    expect(req.url).toBe("/teams/events");
    expect(app).toHaveBeenCalledWith(req, res, next);

    abort.abort();
    await task;
  });

  it("routes SDK SSO invokes through the bounded OpenClaw User Token helper", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<globalThis.Response> => {
        const url = getFetchInputUrl(input);
        if (url.includes("/api/usertoken/exchange")) {
          expect(init?.method).toBe("POST");
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock-token");
          expect(typeof init?.body).toBe("string");
          if (typeof init?.body !== "string") {
            throw new Error("expected token exchange body to be a JSON string");
          }
          expect(JSON.parse(init.body)).toEqual({ token: "exchangeable-token" });
          return createJsonResponse({
            channelId: "msteams",
            connectionName: "graph",
            token: "delegated-token-exchange",
            expiration: "2030-01-01T00:00:00Z",
          });
        }
        if (url.includes("/api/usertoken/GetToken")) {
          expect(init?.method).toBe("GET");
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer mock-token");
          expect(url).toContain("code=654321");
          return createJsonResponse({
            channelId: "msteams",
            connectionName: "graph",
            token: "delegated-token-state",
            expiration: "2031-02-03T04:05:06Z",
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      oauthDefaultConnectionName: "graph",
    });

    const app = await getLoadedMSTeamsApp();
    expect(app.on).toHaveBeenCalledWith("signin.token-exchange", expect.any(Function));
    expect(app.on).toHaveBeenCalledWith("signin.verify-state", expect.any(Function));
    expect(app.event).toHaveBeenCalledWith("signin", expect.any(Function));

    const tokenExchangeHandler = await getRegisteredMSTeamsRoute("signin.token-exchange");
    const exchangeResult = await tokenExchangeHandler({
      activity: {
        type: "invoke",
        name: "signin/tokenExchange",
        channelId: "msteams",
        from: { id: "29:user", aadObjectId: "aad-user" },
        value: {
          id: "exchange-1",
          connectionName: "graph",
          token: "exchangeable-token",
        },
      },
    });
    expect(exchangeResult).toEqual({ status: 200 });

    const verifyStateHandler = await getRegisteredMSTeamsRoute("signin.verify-state");
    const verifyResult = await verifyStateHandler({
      activity: {
        type: "invoke",
        name: "signin/verifyState",
        channelId: "msteams",
        from: { id: "29:user", aadObjectId: "aad-user" },
        value: { state: "654321" },
      },
    });
    expect(verifyResult).toEqual({ status: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(2);
    expect(app.onTokenExchange).not.toHaveBeenCalled();
    expect(app.onVerifyState).not.toHaveBeenCalled();
    expect(ssoTokenStore.save).toHaveBeenCalledTimes(4);
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "29:user",
        token: "delegated-token-exchange",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "aad-user",
        token: "delegated-token-exchange",
        expiresAt: "2030-01-01T00:00:00Z",
      }),
    );
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "29:user",
        token: "delegated-token-state",
        expiresAt: "2031-02-03T04:05:06Z",
      }),
    );
    expect(ssoTokenStore.save).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionName: "graph",
        userId: "aad-user",
        token: "delegated-token-state",
        expiresAt: "2031-02-03T04:05:06Z",
      }),
    );

    abort.abort();
    await task;
  });

  it("preserves the SDK cloud User Token service URL for registered SSO routes", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
      sso: { enabled: true, connectionName: "graph" },
    });
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request): Promise<globalThis.Response> => {
      const url = getFetchInputUrl(input);
      requestedUrls.push(url);
      if (url.includes("/api/usertoken/exchange")) {
        return createJsonResponse({
          channelId: "msteams",
          connectionName: "graph",
          token: "gov-token-exchange",
        });
      }
      if (url.includes("/api/usertoken/GetToken")) {
        return createJsonResponse({
          channelId: "msteams",
          connectionName: "graph",
          token: "gov-token-state",
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
      cloud: "USGov",
      serviceUrl: "https://smba.infra.gov.teams.microsoft.us/teams",
      oauthDefaultConnectionName: "graph",
    });

    const tokenExchangeHandler = await getRegisteredMSTeamsRoute("signin.token-exchange");
    await expect(
      tokenExchangeHandler({
        activity: {
          type: "invoke",
          name: "signin/tokenExchange",
          channelId: "msteams",
          from: { id: "29:user" },
          value: {
            id: "exchange-gov",
            connectionName: "graph",
            token: "exchangeable-token",
          },
        },
      }),
    ).resolves.toEqual({ status: 200 });

    const verifyStateHandler = await getRegisteredMSTeamsRoute("signin.verify-state");
    await expect(
      verifyStateHandler({
        activity: {
          type: "invoke",
          name: "signin/verifyState",
          channelId: "msteams",
          from: { id: "29:user" },
          value: { state: "654321" },
        },
      }),
    ).resolves.toEqual({ status: 200 });

    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls).toEqual([
      expect.stringMatching(
        /^https:\/\/tokengcch\.botframework\.azure\.us\/api\/usertoken\/exchange\?/,
      ),
      expect.stringMatching(
        /^https:\/\/tokengcch\.botframework\.azure\.us\/api\/usertoken\/GetToken\?/,
      ),
    ]);

    abort.abort();
    await task;
  });

  it("rejects oversized User Token responses through registered SSO routes", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => createOversizedResponse()),
    );

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const app = await getLoadedMSTeamsApp();
    const tokenExchangeHandler = await getRegisteredMSTeamsRoute("signin.token-exchange");
    await expect(
      tokenExchangeHandler({
        activity: {
          type: "invoke",
          name: "signin/tokenExchange",
          channelId: "msteams",
          from: { id: "29:user", aadObjectId: "aad-user" },
          value: {
            id: "exchange-oversized",
            connectionName: "graph",
            token: "exchangeable-token",
          },
        },
      }),
    ).resolves.toEqual({
      status: 412,
      body: {
        id: "exchange-oversized",
        connectionName: "graph",
        failureDetail: "unable to exchange token...",
      },
    });

    const verifyStateHandler = await getRegisteredMSTeamsRoute("signin.verify-state");
    await expect(
      verifyStateHandler({
        activity: {
          type: "invoke",
          name: "signin/verifyState",
          channelId: "msteams",
          from: { id: "29:user", aadObjectId: "aad-user" },
          value: { state: "654321" },
        },
      }),
    ).resolves.toEqual({ status: 412 });

    expect(app.onTokenExchange).not.toHaveBeenCalled();
    expect(app.onVerifyState).not.toHaveBeenCalled();
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("does not persist SDK SSO signin events when Teams sender policy denies them", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const signinHandler = app.event.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin",
    )?.[1];
    if (typeof signinHandler !== "function") {
      throw new Error("expected signin event handler");
    }

    signinHandler({
      activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      token: {
        connectionName: "graph",
        token: "delegated-graph-token",
        expiration: "2030-01-01T00:00:00Z",
      },
    });

    await vi.waitFor(() => {
      expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    });
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("blocks SDK SSO token exchange before the SDK calls Bot Framework", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      sso: { enabled: true, connectionName: "graph" },
    });
    isSigninInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const tokenExchangeHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "signin.token-exchange",
    )?.[1];
    if (typeof tokenExchangeHandler !== "function") {
      throw new Error("expected signin token-exchange handler");
    }

    const result = await tokenExchangeHandler({
      activity: { from: { id: "29:blocked", aadObjectId: "aad-blocked" } },
    });

    expect(result).toEqual({ status: 200, body: {} });
    expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(app.onTokenExchange).not.toHaveBeenCalled();
    expect(ssoTokenStore.save).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("falls through non-feedback message.submit invokes to activity dispatch", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const messageSubmitHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "message.submit",
    )?.[1];
    const activityHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "activity",
    )?.[1];
    if (typeof messageSubmitHandler !== "function" || typeof activityHandler !== "function") {
      throw new Error("expected message.submit and activity handlers");
    }

    const activity = {
      type: "invoke",
      name: "message/submitAction",
      value: { actionName: "nonFeedbackAction" },
    };
    const next = vi.fn(async () => {});
    await messageSubmitHandler({ activity, next });
    expect(next).toHaveBeenCalledTimes(1);

    const registeredHandler = registerMSTeamsHandlers.mock.calls[0]?.[0];
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    const run = vi.spyOn(registeredHandler, "run");
    const getTeamDetails = vi.fn(async () => ({ aadGroupId: "activity-aad-group" }));
    await activityHandler({
      activity,
      api: { teams: { getById: getTeamDetails } },
      send: vi.fn(async () => undefined),
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ activity }));
    const adaptedContext = run.mock.calls[0]?.[0] as
      | { getTeamDetails?: (teamId: string) => Promise<{ aadGroupId?: string }> }
      | undefined;
    await expect(adaptedContext?.getTeamDetails?.("activity-team-id")).resolves.toEqual({
      aadGroupId: "activity-aad-group",
    });
    expect(getTeamDetails).toHaveBeenCalledWith("activity-team-id");

    abort.abort();
    await task;
  });

  it("acks file-consent invokes before upload work settles", async () => {
    let releaseUpload: (() => void) | undefined;
    const uploadWork = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    runMSTeamsFileConsentInvokeHandler.mockReturnValueOnce(uploadWork);

    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const fileConsentHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "file.consent.accept",
    )?.[1];
    if (typeof fileConsentHandler !== "function") {
      throw new Error("expected file consent accept handler");
    }

    expect(fileConsentHandler({ activity: { type: "invoke", name: "fileConsent/invoke" } })).toBe(
      undefined,
    );
    expect(runMSTeamsFileConsentInvokeHandler).toHaveBeenCalledTimes(1);
    releaseUpload?.();
    await uploadWork;

    abort.abort();
    await task;
  });

  it("acks non-poll card actions before agent dispatch settles", async () => {
    const abort = new AbortController();
    const task = monitorMSTeamsProvider({
      cfg: createConfig(0),
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }
    const registeredHandler = registerMSTeamsHandlers.mock.calls[0]?.[0];
    if (!registeredHandler) {
      throw new Error("expected registered Teams handler");
    }
    let releaseDispatch: (() => void) | undefined;
    const dispatchWork = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const run = vi.spyOn(registeredHandler, "run").mockReturnValueOnce(dispatchWork);

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        value: { action: { data: { action: "nonPoll" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "OK" });
    expect(run).toHaveBeenCalledTimes(1);
    releaseDispatch?.();
    await dispatchWork;

    abort.abort();
    await task;
  });

  it("gates poll card votes before recording them", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:channel@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };
    isCardActionInvokeAuthorized.mockResolvedValueOnce(false);

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:channel@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Not authorized." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).not.toHaveBeenCalled();
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("rejects poll card votes from the wrong conversation", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    const pollStore: MSTeamsPollStore = {
      createPoll: vi.fn(async () => {}),
      getPoll: vi.fn(async () => ({
        id: "poll-1",
        question: "Ship?",
        options: ["Yes", "No"],
        maxSelections: 1,
        createdAt: "2026-01-01T00:00:00Z",
        conversationId: "19:expected@thread.tacv2",
        votes: {},
      })),
      recordVote: vi.fn(async () => null),
    };

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
    if (!sdkResultPromise) {
      throw new Error("expected loadMSTeamsSdkWithAuth result");
    }
    const app = (await sdkResultPromise).app;
    const cardActionHandler = app.on.mock.calls.find(
      (call: [string, unknown]) => call[0] === "card.action",
    )?.[1];
    if (typeof cardActionHandler !== "function") {
      throw new Error("expected card.action handler");
    }

    const response = await cardActionHandler({
      activity: {
        type: "invoke",
        name: "adaptiveCard/action",
        from: { id: "29:user", aadObjectId: "aad-user" },
        conversation: { id: "19:other@thread.tacv2", conversationType: "channel" },
        value: { action: { data: { openclawPollId: "poll-1", choices: "0" } } },
      },
    });

    expect(response).toMatchObject({ statusCode: 200, value: "Poll not found." });
    expect(isCardActionInvokeAuthorized).toHaveBeenCalledTimes(1);
    expect(pollStore.getPoll).toHaveBeenCalledWith("poll-1");
    expect(pollStore.recordVote).not.toHaveBeenCalled();

    abort.abort();
    await task;
  });

  it("does not resolve user allowlists by display name unless name matching is enabled", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      allowFrom: ["Alice", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      groupAllowFrom: ["Bob", "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198"],
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig.mockResolvedValueOnce({
      teams: {
        "team-id": {
          channels: {
            "channel-id": {},
          },
        },
      },
      mapping: ["Product/Roadmap→team-id/channel-id"],
      unresolved: [],
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
    expect(resolveAllowlistMocks.resolveMSTeamsTeamsConfig).toHaveBeenCalledWith({
      cfg,
      teamIdMode: "bot-framework",
      teams: {
        Product: {
          channels: {
            Roadmap: {},
          },
        },
      },
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
      "50a1a0ed-4ff2-4164-a219-55518990c198",
    ]);
    expect(registeredCfg.channels?.msteams?.teams).toEqual({
      "team-id": {
        channels: {
          "channel-id": {},
        },
      },
    });

    abort.abort();
    await task;
  });

  it("resolves user allowlists when name matching is enabled", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(true);
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist
      .mockResolvedValueOnce([{ input: "Alice", resolved: true, id: "alice-aad" }])
      .mockResolvedValueOnce([{ input: "Bob", resolved: true, id: "bob-aad" }]);

    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice"],
      groupAllowFrom: ["Bob"],
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(1, {
      cfg,
      entries: ["Alice"],
    });
    expect(resolveAllowlistMocks.resolveMSTeamsUserAllowlist).toHaveBeenNthCalledWith(2, {
      cfg,
      entries: ["Bob"],
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual(["bob-aad"]);

    abort.abort();
    await task;
  });

  it("keeps only stable allowlist entries when Graph resolution fails", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(true);
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockRejectedValueOnce(
      new Error("Graph unavailable"),
    );
    const runtime = createRuntime();
    const abort = new AbortController();
    const cfg = createConfig(0);
    updateMSTeamsConfig(cfg, {
      dangerouslyAllowNameMatching: true,
      allowFrom: ["Alice", "accessGroup:operators", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
      teams: {
        Mutable: {
          channels: {
            Roadmap: {},
          },
        },
        "19:stable-team@thread.tacv2": {
          channels: {
            "19:stable-channel@thread.tacv2": {},
          },
        },
      },
    });

    const task = monitorMSTeamsProvider({
      cfg,
      runtime,
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(registerMSTeamsHandlers).toHaveBeenCalled();
    });

    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.allowFrom).toEqual([
      "accessGroup:operators",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(requireRegisteredMSTeamsConfig().channels?.msteams?.teams).toEqual({
      "19:stable-team@thread.tacv2": {
        channels: {
          "19:stable-channel@thread.tacv2": {},
        },
      },
    });
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("mutable allowlist entries are disabled"),
    );

    abort.abort();
    await task;
  });
});
