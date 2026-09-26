import type { App } from "@microsoft/teams.apps";
import type { Request, Response } from "express";
import type { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-targets";
import { vi } from "vitest";
import type { createMSTeamsActivityHandler as CreateMSTeamsActivityHandler } from "./monitor-handler.js";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";

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

const routeState = vi.hoisted(() => ({
  routes: [] as Array<Parameters<typeof registerPluginHttpRoute>[0]>,
  ready: Promise.withResolvers<void>(),
  unregister: vi.fn(),
  fail: false,
  requestStarted: Promise.withResolvers<void>(),
  responseGate: undefined as Promise<void> | undefined,
  responseWork: undefined as Promise<boolean | void> | undefined,
}));
vi.mock("openclaw/plugin-sdk/webhook-targets", () => ({
  registerPluginHttpRoute: (route: Parameters<typeof registerPluginHttpRoute>[0]) => {
    if (routeState.fail) {
      throw new Error("route conflict");
    }
    routeState.routes.push(route);
    routeState.ready.resolve();
    return routeState.unregister;
  },
}));

const createMSTeamsActivityHandler = vi.hoisted(() =>
  vi.fn<typeof CreateMSTeamsActivityHandler>(() => vi.fn(async () => undefined)),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const processSdkActivity = vi.hoisted(() => vi.fn<App["process"]>(async () => ({ status: 200 })));
const nativeSdkState = vi.hoisted((): { app?: App } => ({}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, options?: Record<string, unknown>) => {
    const app = {
      on: vi.fn(),
      event: vi.fn(),
      process: processSdkActivity,
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
          adapter.registerRoute(endpoint, async (req, res) => {
            routeState.requestStarted.resolve();
            await routeState.responseGate;
            res.status(200).json({ url: req.url });
          });
        }
      }),
      tokenProvider: {
        getAppToken: vi.fn(async (scope: string) => ({
          toString: (): string =>
            scope === "https://graph.microsoft.com/.default" ? "graph-token" : "bot-token",
        })),
      },
    };
    if (nativeSdkState.app) {
      app.on.mockImplementation(nativeSdkState.app.on.bind(nativeSdkState.app));
      app.event.mockImplementation(nativeSdkState.app.event.bind(nativeSdkState.app));
      processSdkActivity.mockImplementation(nativeSdkState.app.process.bind(nativeSdkState.app));
    }
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
  createMSTeamsActivityHandler,
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

export function resetMSTeamsMonitorMocks() {
  vi.clearAllMocks();
  routeState.unregister.mockReset();
  routeState.routes = [];
  routeState.ready = Promise.withResolvers<void>();
  routeState.fail = false;
  routeState.requestStarted = Promise.withResolvers<void>();
  routeState.responseGate = undefined;
  routeState.responseWork = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resolveAllowlistMocks.resolveMSTeamsTeamsConfig
    .mockReset()
    .mockImplementation(async ({ teams }) => ({ teams, mapping: [], unresolved: [] }));
  resolveAllowlistMocks.resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
  isSigninInvokeAuthorized.mockReset().mockResolvedValue(true);
  isCardActionInvokeAuthorized.mockReset().mockResolvedValue(true);
  runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
  processSdkActivity.mockReset().mockResolvedValue({ status: 200 });
  nativeSdkState.app = undefined;
  getMSTeamsIngressMockState().instances.length = 0;
  ssoTokenStore.get.mockClear();
  ssoTokenStore.save.mockReset().mockResolvedValue(undefined);
  ssoTokenStore.remove.mockClear();
}

export {
  routeState,
  createMSTeamsActivityHandler,
  isSigninInvokeAuthorized,
  isCardActionInvokeAuthorized,
  runMSTeamsFileConsentInvokeHandler,
  processSdkActivity,
  nativeSdkState,
  loadMSTeamsSdkWithAuth,
  ssoTokenStore,
  resolveAllowlistMocks,
};
