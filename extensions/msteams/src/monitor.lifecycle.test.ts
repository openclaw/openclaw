import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler, MSTeamsMessageHandlerDeps } from "./monitor-handler.js";
import type { MSTeamsPollStore } from "./polls.js";

type FakeServer = EventEmitter & {
  close: (callback?: (err?: Error | null) => void) => void;
  setTimeout: (msecs: number) => FakeServer;
  requestTimeout: number;
  headersTimeout: number;
};

type MSTeamsChannelResolution = {
  input: string;
  resolved: boolean;
  teamId?: string;
  channelId?: string;
};

type MSTeamsUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
};

type ResolveMSTeamsChannelAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsChannelResolution[]>;

type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;

type RegisterMSTeamsHandlersMock = (
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
) => MSTeamsActivityHandler;

const expressControl = vi.hoisted(() => ({
  mode: { value: "listening" as "listening" | "error" },
  apps: [] as Array<{
    use: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    listen: ReturnType<typeof vi.fn>;
  }>,
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

  const factory = () => ({
    use: vi.fn(),
    post: vi.fn(),
    listen: vi.fn((_port: number) => {
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
    }),
  });

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
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async () => ({
    app: {
      on: vi.fn(),
      initialize: vi.fn(async () => {}),
      tokenManager: {
        getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
        getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
      },
    },
  })),
);

vi.mock("@microsoft/teams.apps", () => ({
  ExpressAdapter: vi.fn(),
}));

vi.mock("./monitor-handler.js", () => ({
  registerMSTeamsHandlers,
}));

const resolveAllowlistMocks = vi.hoisted(() => ({
  resolveMSTeamsChannelAllowlist: vi.fn<ResolveMSTeamsChannelAllowlistMock>(async () => []),
  resolveMSTeamsUserAllowlist: vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
}));

vi.mock("./resolve-allowlist.js", () => ({
  resolveMSTeamsChannelAllowlist: resolveAllowlistMocks.resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist: resolveAllowlistMocks.resolveMSTeamsUserAllowlist,
}));

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: () => loadMSTeamsSdkWithAuth(),
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
    resolveAllowlistMocks.resolveMSTeamsChannelAllowlist.mockReset().mockResolvedValue([]);
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
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
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
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

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const app = expressControl.apps.at(-1);
    expect(app).toBeDefined();
    // Two middlewares are installed before the SDK route registers:
    // [0] = `express.json({ limit })` — caps inbound bodies before any handler
    //       parses them (forces the SDK's later json() to be a no-op).
    // [1] = bearer-presence gate — rejects unauthenticated requests cheaply.
    expect(app!.use.mock.calls.length).toBeGreaterThanOrEqual(2);

    const bearerMiddleware = app!.use.mock.calls[1]?.[0] as (
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
    resolveAllowlistMocks.resolveMSTeamsChannelAllowlist.mockResolvedValueOnce([
      {
        input: "Product/Roadmap",
        resolved: true,
        teamId: "team-id",
        channelId: "channel-id",
      },
    ]);

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
    expect(resolveAllowlistMocks.resolveMSTeamsChannelAllowlist).toHaveBeenCalledWith({
      cfg,
      entries: ["Product/Roadmap"],
    });

    const registeredCfg = requireRegisteredMSTeamsConfig();
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
      "Alice",
      "user:40a1a0ed-4ff2-4164-a219-55518990c197",
      "40a1a0ed-4ff2-4164-a219-55518990c197",
    ]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
      "Bob",
      "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198",
      "50a1a0ed-4ff2-4164-a219-55518990c198",
    ]);

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
    expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["Alice", "alice-aad"]);
    expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual(["Bob", "bob-aad"]);

    abort.abort();
    await task;
  });
});
