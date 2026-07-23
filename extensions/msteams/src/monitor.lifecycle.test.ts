// Msteams tests cover monitor.lifecycle plugin behavior.
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import type { MSTeamsPollStore } from "./polls.js";
import type { MSTeamsSsoStoredToken } from "./sso-token-store.js";

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
const keepHttpServerTaskAliveMock = vi.hoisted(() =>
  vi.fn(async (params: { abortSignal?: AbortSignal; onAbort?: () => Promise<void> | void }) => {
    await new Promise<void>((resolve) => {
      if (params.abortSignal?.aborted) {
        resolve();
        return;
      }
      params.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    await params.onAbort?.();
  }),
);

vi.mock("../runtime-api.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  DEFAULT_WEBHOOK_MAX_BODY_BYTES: 1024 * 1024,
  isDangerousNameMatchingEnabled,
  normalizeSecretInputString: (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  hasConfiguredSecretInput: (value: unknown) =>
    typeof value === "string" && value.trim().length > 0,
  normalizeResolvedSecretInputString: (params: { value?: unknown }) =>
    typeof params?.value === "string" && params.value.trim() ? params.value.trim() : undefined,
  keepHttpServerTaskAlive: keepHttpServerTaskAliveMock,
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
    app.listen = vi.fn((_port: number, callback?: (error?: Error) => void) => {
      const server = new EventEmitter() as FakeServer;
      server.setTimeout = vi.fn((_msecs: number) => server);
      server.requestTimeout = 0;
      server.headersTimeout = 0;
      server.close = (closeCallback?: (err?: Error | null) => void) => {
        queueMicrotask(() => {
          server.emit("close");
          closeCallback?.(null);
        });
      };
      queueMicrotask(() => {
        if (expressControl.mode.value === "error") {
          callback?.(new Error("listen EADDRINUSE"));
          return;
        }
        callback?.();
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
  vi.fn(async (_creds?: unknown, _options?: unknown) => ({
    app: {
      on: vi.fn(),
      event: vi.fn(),
      onTokenExchange: vi.fn(async () => ({ status: 200 })),
      onVerifyState: vi.fn(async () => ({ status: 200 })),
      initialize: vi.fn(async () => {}),
      tokenManager: {
        getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
        getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
      },
    },
  })),
);

const ssoTokenStore = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  save: vi.fn(async (_token: MSTeamsSsoStoredToken) => {}),
  remove: vi.fn(async () => false),
}));
const createMSTeamsSsoTokenStoreFs = vi.hoisted(() => vi.fn(() => ssoTokenStore));

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
  createMSTeamsSsoTokenStoreFs,
}));

import { monitorMSTeamsProvider } from "./monitor.js";

async function waitForMSTeamsTestState(assertion: () => void | Promise<void>): Promise<void> {
  await vi.waitFor(assertion, { interval: 1 });
}

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
    runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
    getMSTeamsIngressMockState().instances.length = 0;
    ssoTokenStore.get.mockClear();
    ssoTokenStore.save.mockClear();
    ssoTokenStore.remove.mockClear();
    createMSTeamsSsoTokenStoreFs.mockClear();
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

    let taskSettled = false;
    void task.then(
      () => {
        taskSettled = true;
      },
      () => {
        taskSettled = true;
      },
    );
    await waitForMSTeamsTestState(() => {
      expect(keepHttpServerTaskAliveMock).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    expect(taskSettled).toBe(false);

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected Teams monitor app after startup abort");
    }
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("treats omitted enabled as enabled during provider startup", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    delete cfg.channels!.msteams!.enabled;

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

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected Teams monitor app with omitted enabled");
    }
    await expect(result.shutdown()).resolves.toBeUndefined();
  });

  it("resolves named account config when only accountId is provided", async () => {
    const abort = new AbortController();
    const cfg = {
      channels: {
        msteams: {
          tenantId: "tenant-id",
          sso: { enabled: true, connectionName: "graph" },
          accounts: {
            support: {
              appId: "support-app-id",
              appPassword: "support-app-password",
              webhook: {
                port: 0,
                path: "/api/messages",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const task = monitorMSTeamsProvider({
      cfg,
      accountId: "support",
      runtime: createRuntime(),
      abortSignal: abort.signal,
      conversationStore: createStores().conversationStore,
      pollStore: createStores().pollStore,
    });

    await vi.waitFor(() => {
      expect(expressControl.apps.length).toBeGreaterThan(0);
    });
    expect(loadMSTeamsSdkWithAuth).toHaveBeenCalledWith(
      {
        appId: "support-app-id",
        appPassword: "support-app-password",
        tenantId: "tenant-id",
        type: "secret",
      },
      expect.objectContaining({ cloud: "Public", oauthDefaultConnectionName: "graph" }),
    );
    expect(createMSTeamsSsoTokenStoreFs).toHaveBeenCalledWith({ accountId: "support" });

    abort.abort();
    const result = await task;
    if (!result.app) {
      throw new Error("expected named Teams monitor app");
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

    await waitForMSTeamsTestState(() => {
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

    await waitForMSTeamsTestState(() => {
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

    await waitForMSTeamsTestState(() => {
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

  it.each([DEFAULT_ACCOUNT_ID, "support"])(
    "gates SDK SSO invoke routes and persists successful signin events for %s",
    async (accountId) => {
      const abort = new AbortController();
      const cfg = createConfig(0);
      updateMSTeamsConfig(cfg, {
        sso: { enabled: true, connectionName: "graph" },
        ...(accountId === DEFAULT_ACCOUNT_ID
          ? {}
          : {
              accounts: {
                [accountId]: {
                  appId: `${accountId}-app-id`,
                  appPassword: `${accountId}-secret`,
                  webhook: { port: 0 },
                },
              },
            }),
      });

      const task = monitorMSTeamsProvider({
        cfg,
        accountId,
        runtime: createRuntime(),
        abortSignal: abort.signal,
        conversationStore: createStores().conversationStore,
        pollStore: createStores().pollStore,
      });

      await waitForMSTeamsTestState(() => {
        expect(registerMSTeamsHandlers).toHaveBeenCalled();
      });

      expect(loadMSTeamsSdkWithAuth.mock.calls[0]?.[1]).toMatchObject({
        oauthDefaultConnectionName: "graph",
      });

      const sdkResultPromise = loadMSTeamsSdkWithAuth.mock.results[0]?.value;
      if (!sdkResultPromise) {
        throw new Error("expected loadMSTeamsSdkWithAuth result");
      }
      const sdkResult = await sdkResultPromise;
      const app = sdkResult.app;
      expect(app.on).toHaveBeenCalledWith("signin.token-exchange", expect.any(Function));
      expect(app.on).toHaveBeenCalledWith("signin.verify-state", expect.any(Function));
      expect(app.event).toHaveBeenCalledWith("signin", expect.any(Function));

      const tokenExchangeHandler = app.on.mock.calls.find(
        (call: [string, unknown]) => call[0] === "signin.token-exchange",
      )?.[1];
      expect(typeof tokenExchangeHandler).toBe("function");
      if (typeof tokenExchangeHandler !== "function") {
        throw new Error("expected signin token-exchange handler");
      }
      const exchangeResult = await tokenExchangeHandler({
        activity: { from: { id: "29:user", aadObjectId: "aad-user" } },
      });
      expect(exchangeResult).toEqual({ status: 200 });
      expect(app.onTokenExchange).toHaveBeenCalledTimes(1);

      const signinHandler = app.event.mock.calls.find(
        (call: [string, unknown]) => call[0] === "signin",
      )?.[1];
      expect(typeof signinHandler).toBe("function");
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
        expect(isSigninInvokeAuthorized).toHaveBeenCalledTimes(2);
        expect(ssoTokenStore.save).toHaveBeenCalledTimes(2);
      });
      for (const [token] of ssoTokenStore.save.mock.calls) {
        expect(token).toMatchObject({
          connectionName: "graph",
          token: "delegated-graph-token",
          expiresAt: "2030-01-01T00:00:00Z",
        });
        expect(token.accountId).toBe(accountId === DEFAULT_ACCOUNT_ID ? undefined : accountId);
      }
      expect(ssoTokenStore.save.mock.calls.map(([token]) => token.userId)).toEqual([
        "29:user",
        "aad-user",
      ]);

      abort.abort();
      await task;
    },
  );

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

    await waitForMSTeamsTestState(() => {
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

    await waitForMSTeamsTestState(() => {
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

    await waitForMSTeamsTestState(() => {
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
});
