// Provider startup must preserve Teams thread identities in group-only allowlists.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import type { createMSTeamsActivityHandler as CreateMSTeamsActivityHandler } from "./monitor-handler.js";
import { getMSTeamsIngressMockState } from "./monitor-ingress-mock.test-support.js";
import type { MSTeamsPollStore } from "./polls.js";

type MSTeamsUserResolution = { input: string; resolved: boolean; id?: string };
type ResolveMSTeamsUserAllowlistMock = (params: {
  cfg: unknown;
  entries: string[];
}) => Promise<MSTeamsUserResolution[]>;

const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const monitorReady = vi.hoisted(() => ({ current: Promise.withResolvers<void>() }));
vi.mock("../runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime-api.js")>()),
  isDangerousNameMatchingEnabled,
  summarizeMapping: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/webhook-targets", () => ({
  registerPluginHttpRoute: () => {
    monitorReady.current.resolve();
    return () => {};
  },
}));

const createMSTeamsActivityHandler = vi.hoisted(() =>
  vi.fn<typeof CreateMSTeamsActivityHandler>(() => vi.fn(async () => undefined)),
);
const resolveMSTeamsUserAllowlist = vi.hoisted(() =>
  vi.fn<ResolveMSTeamsUserAllowlistMock>(async () => []),
);
const loadMSTeamsSdkWithAuth = vi.hoisted(() =>
  vi.fn(async (_creds?: unknown, _options?: unknown) => ({
    app: {
      on: vi.fn(),
      event: vi.fn(),
      process: vi.fn(async () => ({ status: 200 })),
      initialize: vi.fn(async () => {}),
      tokenProvider: {
        getAppToken: vi.fn(async (scope: string) => ({
          toString: (): string =>
            scope === "https://graph.microsoft.com/.default" ? "graph-token" : "bot-token",
        })),
      },
    },
  })),
);

vi.mock("@microsoft/teams.apps", () => ({ ExpressAdapter: vi.fn() }));
vi.mock("./monitor-handler.js", () => ({
  isCardActionInvokeAuthorized: vi.fn(async () => true),
  isSigninInvokeAuthorized: vi.fn(async () => true),
  createMSTeamsActivityHandler,
}));
vi.mock("./file-consent-invoke.js", () => ({
  runMSTeamsFileConsentInvokeHandler: vi.fn(async () => {}),
}));
vi.mock("./resolve-allowlist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve-allowlist.js")>()),
  resolveMSTeamsTeamsConfig: vi.fn(async (params: { teams: Record<string, unknown> }) => ({
    teams: params.teams,
    mapping: [],
    unresolved: [],
  })),
  resolveMSTeamsUserAllowlist,
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
    channel: { text: { resolveTextChunkLimit: () => 4000 } },
  }),
}));
vi.mock("./sso-token-store.js", () => ({
  createMSTeamsSsoTokenStoreFs: () => ({
    get: vi.fn(async () => null),
    save: vi.fn(async () => {}),
    remove: vi.fn(async () => false),
  }),
}));

import { monitorMSTeamsProvider } from "./monitor.js";

function createConfig(patch: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        legacyWebhook: false,
        webhook: { path: "/api/messages" },
        ...patch,
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

function requireRegisteredMSTeamsConfig(): OpenClawConfig {
  const registered = createMSTeamsActivityHandler.mock.calls[0]?.[0];
  if (!registered?.cfg) {
    throw new Error("expected registered MSTeams handler config");
  }
  return registered.cfg;
}

async function withStartedProvider(
  cfg: OpenClawConfig,
  verify: (registeredCfg: OpenClawConfig) => void,
): Promise<void> {
  const abort = new AbortController();
  const task = monitorMSTeamsProvider({
    cfg,
    runtime: createRuntime(),
    abortSignal: abort.signal,
    conversationStore: {} as MSTeamsConversationStore,
    pollStore: {} as MSTeamsPollStore,
  });
  try {
    await monitorReady.current.promise;
    expect(createMSTeamsActivityHandler).toHaveBeenCalled();
    verify(requireRegisteredMSTeamsConfig());
  } finally {
    abort.abort();
    await task;
  }
}

describe("monitorMSTeamsProvider group conversation allowlist lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
    monitorReady.current = Promise.withResolvers<void>();
    isDangerousNameMatchingEnabled.mockReset().mockReturnValue(false);
    resolveMSTeamsUserAllowlist.mockReset().mockResolvedValue([]);
    getMSTeamsIngressMockState().instances.length = 0;
  });

  it.each([false, true])(
    "preserves stable thread allowlists without widening DMs (name matching: %s)",
    async (dangerouslyAllowNameMatching) => {
      isDangerousNameMatchingEnabled.mockReturnValue(dangerouslyAllowNameMatching);
      const cfg = createConfig({
        dangerouslyAllowNameMatching,
        allowFrom: ["19:group@thread.tacv2", "user:40a1a0ed-4ff2-4164-a219-55518990c197"],
        groupAllowFrom: [
          "19:group@thread.tacv2;messageid=1740123456789",
          "19:MiXeD-group@thread.tacv2;messageid=1740123456789",
          "19:modern-group@thread.v2;messageid=1740123456789",
          "19:legacy@thread.skype",
          "msteams:user:50a1a0ed-4ff2-4164-a219-55518990c198",
        ],
      });

      await withStartedProvider(cfg, (registeredCfg) => {
        expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
          "19:group@thread.tacv2",
          "19:MiXeD-group@thread.tacv2",
          "19:modern-group@thread.v2",
          "19:legacy@thread.skype",
          "50a1a0ed-4ff2-4164-a219-55518990c198",
        ]);
        expect(resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
      });
    },
  );

  it.each([false, true])(
    "preserves fallback thread allowlists without widening DMs (name matching: %s)",
    async (dangerouslyAllowNameMatching) => {
      isDangerousNameMatchingEnabled.mockReturnValue(dangerouslyAllowNameMatching);
      const cfg = createConfig({
        dangerouslyAllowNameMatching,
        allowFrom: [
          "19:fallback-group@thread.v2;messageid=1740123456789",
          "user:40a1a0ed-4ff2-4164-a219-55518990c197",
        ],
      });

      await withStartedProvider(cfg, (registeredCfg) => {
        expect(registeredCfg.channels?.msteams?.allowFrom).toEqual([
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
          "19:fallback-group@thread.v2",
          "40a1a0ed-4ff2-4164-a219-55518990c197",
        ]);
        expect(resolveMSTeamsUserAllowlist).not.toHaveBeenCalled();
      });
    },
  );

  it("preserves Graph-resolved sender identities in the group fallback", async () => {
    isDangerousNameMatchingEnabled.mockReturnValue(true);
    resolveMSTeamsUserAllowlist.mockResolvedValueOnce([
      { input: "Alice", resolved: true, id: "alice-aad" },
    ]);
    const cfg = createConfig({
      dangerouslyAllowNameMatching: true,
      allowFrom: ["19:fallback-group@thread.v2;messageid=1740123456789", "Alice"],
    });

    await withStartedProvider(cfg, (registeredCfg) => {
      expect(registeredCfg.channels?.msteams?.allowFrom).toEqual(["alice-aad"]);
      expect(registeredCfg.channels?.msteams?.groupAllowFrom).toEqual([
        "19:fallback-group@thread.v2",
        "alice-aad",
      ]);
      expect(resolveMSTeamsUserAllowlist).toHaveBeenCalledExactlyOnceWith({
        cfg,
        entries: ["Alice"],
      });
    });
  });
});
