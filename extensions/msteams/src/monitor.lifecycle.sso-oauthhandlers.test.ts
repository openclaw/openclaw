// Msteams tests cover monitor.lifecycle plugin behavior for the SDK 2.0.x
// oauthHandlers sign-in delegate shape.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { MSTeamsActivityHandler } from "./monitor-handler.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsPollStore } from "./polls.js";

type RegisterMSTeamsHandlersMock = (
  handler: MSTeamsActivityHandler,
  deps: MSTeamsMessageHandlerDeps,
) => MSTeamsActivityHandler;

const registerMSTeamsHandlers = vi.hoisted(() =>
  vi.fn<RegisterMSTeamsHandlersMock>((handler) => handler),
);
const isSigninInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const isCardActionInvokeAuthorized = vi.hoisted(() => vi.fn(async () => true));
const runMSTeamsFileConsentInvokeHandler = vi.hoisted(() => vi.fn(async () => {}));
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, _options?: Record<string, unknown>) => ({ app: {} })),
);

const ssoTokenStore = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  save: vi.fn(async () => {}),
  remove: vi.fn(async () => false),
}));

vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized,
  isSigninInvokeAuthorized,
  registerMSTeamsHandlers,
}));

vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler,
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

vi.mock("./sdk.js", () => ({
  loadMSTeamsSdkWithAuth: (creds?: unknown, options?: Record<string, unknown>) =>
    loadMSTeamsSdkWithAuth(creds, options),
  createMSTeamsTokenProvider: () => ({
    getAccessToken: vi.fn().mockResolvedValue("mock-token"),
  }),
  createMSTeamsExpressAdapter: vi.fn(async () => ({
    registerRoute: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

// The ingress mock support registers its vi.mock at import time; it must be
// imported before ./monitor.js pulls in the real msteams-ingress module.
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
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

describe("monitorMSTeamsProvider SSO oauthHandlers delegate", () => {
  afterEach(() => {
    vi.clearAllMocks();
    isSigninInvokeAuthorized.mockReset().mockResolvedValue(true);
    isCardActionInvokeAuthorized.mockReset().mockResolvedValue(true);
    runMSTeamsFileConsentInvokeHandler.mockReset().mockResolvedValue(undefined);
    getMSTeamsIngressMockState().instances.length = 0;
    ssoTokenStore.get.mockClear();
    ssoTokenStore.save.mockClear();
    ssoTokenStore.remove.mockClear();
  });

  it("reaches the SDK sign-in handlers through app.oauthHandlers (SDK 2.0.x shape)", async () => {
    const abort = new AbortController();
    const cfg = createConfig(0);
    const msteamsCfg = cfg.channels?.msteams;
    if (!msteamsCfg) {
      throw new Error("Expected Microsoft Teams config fixture");
    }
    cfg.channels!.msteams = { ...msteamsCfg, sso: { enabled: true, connectionName: "graph" } };

    // @microsoft/teams.apps 2.0.x defines these handlers as arrow-function
    // class fields on OauthHandlers, reached via `app.oauthHandlers` — not on
    // the App instance itself.
    const oauthHandlers = {
      onTokenExchange: vi.fn(async () => ({ status: 200 })),
      onVerifyState: vi.fn(async () => ({ status: 200 })),
    };
    loadMSTeamsSdkWithAuth.mockImplementationOnce(async () => ({
      app: {
        on: vi.fn(),
        event: vi.fn(),
        oauthHandlers,
        initialize: vi.fn(async () => {}),
        tokenManager: {
          getBotToken: vi.fn(async () => ({ toString: (): string => "bot-token" })),
          getGraphToken: vi.fn(async () => ({ toString: (): string => "graph-token" })),
        },
      },
    }));

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
    const app = (await sdkResultPromise).app as {
      on: ReturnType<typeof vi.fn>;
    };
    const tokenExchangeHandler = app.on.mock.calls.find(
      (call: unknown[]) => call[0] === "signin.token-exchange",
    )?.[1];
    if (typeof tokenExchangeHandler !== "function") {
      throw new Error("expected signin token-exchange handler");
    }

    const exchangeResult = await tokenExchangeHandler({
      activity: { from: { id: "29:oauth", aadObjectId: "aad-oauth" } },
    });

    expect(exchangeResult).toEqual({ status: 200 });
    expect(oauthHandlers.onTokenExchange).toHaveBeenCalledTimes(1);

    abort.abort();
    await task;
  });
});
