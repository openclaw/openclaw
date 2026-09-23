// Shared monitor fixtures retain the installed Teams SDK sign-in implementation.
import type { Server } from "node:http";
import type { Request, Response } from "express";
import { afterEach, expect, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import type { MSTeamsPollStore } from "./polls.js";

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

const keepHttpServerTaskAliveMock = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime-api.js")>();
  keepHttpServerTaskAliveMock.mockImplementation(actual.keepHttpServerTaskAlive);
  return {
    ...actual,
    keepHttpServerTaskAlive: keepHttpServerTaskAliveMock,
  };
});

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn<RegisterMSTeamsHandlersMock>((handler) => handler),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, options?: Record<string, unknown>) => {
    const { App } =
      await vi.importActual<typeof import("@microsoft/teams.apps/dist/app.js")>(
        "@microsoft/teams.apps",
      );
    const sdkApp = new App({
      clientId: "test-app-id",
      clientSecret: "test-secret",
      tenantId: "test-tenant",
      oauth: { defaultConnectionName: "graph" },
    });
    // Keep the installed SDK's sign-in handlers and event emitter; only the
    // server bootstrap is fake. This catches SDK handler-placement changes.
    const app = Object.assign(sdkApp, {
      on: vi.fn(),
      event: vi.fn(sdkApp.event.bind(sdkApp)),
      initialize: vi.fn(async () => {
        const adapter = options?.httpServerAdapter as
          | {
              registerRoute?: (
                path: string,
                handler: (req: Request, res: Response) => void,
              ) => void;
            }
          | undefined;
        const endpoint = options?.messagingEndpoint;
        if (adapter?.registerRoute && typeof endpoint === "string") {
          adapter.registerRoute(endpoint, (req, res) => {
            res.status(200).json({ url: req.url });
          });
        }
      }),
    });
    return { app };
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
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: Record<string, unknown>) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createMSTeamsExpressAdapter: vi.fn(
    async (expressApp: { post: (...args: unknown[]) => void }) => ({
      registerRoute: (path: string, handler: (req: Request, res: Response) => void) =>
        expressApp.post(path, handler),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    }),
  ),
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

export async function waitForMSTeamsTestState(
  assertion: () => void | Promise<void>,
): Promise<void> {
  await vi.waitFor(assertion, { interval: 1 });
}

export function createConfig(port: number): OpenClawConfig {
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

export function updateMSTeamsConfig(
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

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

export function createStores() {
  return {
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  };
}

export async function resolveStartedServer(): Promise<Server> {
  await waitForMSTeamsTestState(() => {
    expect(keepHttpServerTaskAliveMock).toHaveBeenCalled();
  });
  const server = keepHttpServerTaskAliveMock.mock.calls.at(-1)?.[0]?.server as Server | undefined;
  if (!server) {
    throw new Error("expected started Microsoft Teams HTTP server");
  }
  return server;
}

export function resolveServerUrl(server: Server, path: string): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}${path}`;
}

export function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1] as
    | { cfg?: OpenClawConfig }
    | undefined;
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

export function requireRegisteredMSTeamsMediaMaxBytes(): number {
  const registered = registerMSTeamsHandlers.mock.calls[0]?.[1];
  if (!registered) {
    throw new Error("expected registered MSTeams handler dependencies");
  }
  return registered.mediaMaxBytes;
}

export function installMonitorLifecycleTestHooks() {
  afterEach(() => {
    vi.clearAllMocks();
    resolveAllowlistMocks.resolveMSTeamsTeamsConfig
      .mockReset()
      .mockImplementation(async ({ teams }) => ({ teams, mapping: [], unresolved: [] }));
    resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
    isSigninInvokeAuthorized.mockReset().mockResolvedValue(true);
    isCardActionInvokeAuthorized.mockReset().mockResolvedValue(true);
    runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
    getMSTeamsIngressMockState().instances.length = 0;
    ssoTokenStore.get.mockClear();
    ssoTokenStore.save.mockReset().mockResolvedValue(undefined);
    ssoTokenStore.remove.mockClear();
  });
}

export {
  keepHttpServerTaskAliveMock,
  registerMSTeamsHandlers,
  isSigninInvokeAuthorized,
  isCardActionInvokeAuthorized,
  runMSTeamsFileConsentInvokeHandler,
  loadMSTeamsSdkWithAuth,
  ssoTokenStore,
  resolveAllowlistMocks,
};
