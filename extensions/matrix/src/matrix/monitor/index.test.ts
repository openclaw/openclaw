import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const callOrder: string[] = [];
  const client = {
    id: "matrix-client",
    hasPersistedSyncState: vi.fn(() => false),
  };
  const createMatrixRoomMessageHandler = vi.fn(() => vi.fn());
  const resolveTextChunkLimit = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => number
  >(() => 4000);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stopThreadBindingManager = vi.fn();
  const releaseSharedClientInstance = vi.fn(async () => true);
  const setActiveMatrixClient = vi.fn();
  return {
    callOrder,
    client,
    createMatrixRoomMessageHandler,
    logger,
    releaseSharedClientInstance,
    resolveTextChunkLimit,
    setActiveMatrixClient,
    startClientError: null as Error | null,
    stopThreadBindingManager,
  };
});

vi.mock("openclaw/plugin-sdk/matrix", () => ({
  GROUP_POLICY_BLOCKED_LABEL: {
    room: "room",
  },
  mergeAllowlist: ({ existing, additions }: { existing: string[]; additions: string[] }) => [
    ...existing,
    ...additions,
  ],
  resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
  resolveThreadBindingMaxAgeMsForChannel: () => 0,
  resolveAllowlistProviderRuntimeGroupPolicy: () => ({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "allowlist",
  summarizeMapping: vi.fn(),
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("../../resolve-targets.js", () => ({
  resolveMatrixTargets: vi.fn(async () => []),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      loadConfig: () => ({
        channels: {
          matrix: {},
        },
      }),
      writeConfigFile: vi.fn(),
    },
    logging: {
      getChildLogger: () => hoisted.logger,
      shouldLogVerbose: () => false,
    },
    channel: {
      mentions: {
        buildMentionRegexes: () => [],
      },
      text: {
        resolveTextChunkLimit: (cfg: unknown, channel: unknown, accountId?: unknown) =>
          hoisted.resolveTextChunkLimit(cfg, channel, accountId),
      },
    },
    system: {
      formatNativeDependencyHint: () => "",
    },
    media: {
      loadWebMedia: vi.fn(),
    },
  }),
}));

vi.mock("../accounts.js", () => ({
  resolveMatrixAccount: () => ({
    accountId: "default",
    config: {
      dm: {},
    },
  }),
}));

vi.mock("../active-client.js", () => ({
  setActiveMatrixClient: hoisted.setActiveMatrixClient,
}));

vi.mock("../client.js", () => ({
  isBunRuntime: () => false,
  resolveMatrixAuth: vi.fn(async () => ({
    accountId: "default",
    homeserver: "https://matrix.example.org",
    userId: "@bot:example.org",
    accessToken: "token",
    initialSyncLimit: 20,
    encryption: false,
  })),
  resolveMatrixAuthContext: vi.fn(() => ({
    accountId: "default",
  })),
  resolveSharedMatrixClient: vi.fn(async (params: { startClient?: boolean }) => {
    if (params.startClient === false) {
      hoisted.callOrder.push("prepare-client");
      return hoisted.client;
    }
    if (!hoisted.callOrder.includes("create-manager")) {
      throw new Error("Matrix client started before thread bindings were registered");
    }
    if (hoisted.startClientError) {
      throw hoisted.startClientError;
    }
    hoisted.callOrder.push("start-client");
    return hoisted.client;
  }),
}));

vi.mock("../client/shared.js", () => ({
  releaseSharedClientInstance: hoisted.releaseSharedClientInstance,
}));

vi.mock("../config-update.js", () => ({
  updateMatrixAccountConfig: vi.fn((cfg: unknown) => cfg),
}));

vi.mock("../device-health.js", () => ({
  summarizeMatrixDeviceHealth: vi.fn(() => ({
    staleOpenClawDevices: [],
  })),
}));

vi.mock("../profile.js", () => ({
  syncMatrixOwnProfile: vi.fn(async () => ({
    displayNameUpdated: false,
    avatarUpdated: false,
    convertedAvatarFromHttp: false,
    resolvedAvatarUrl: undefined,
  })),
}));

vi.mock("../thread-bindings.js", () => ({
  createMatrixThreadBindingManager: vi.fn(async () => {
    hoisted.callOrder.push("create-manager");
    return {
      accountId: "default",
      stop: hoisted.stopThreadBindingManager,
    };
  }),
}));

vi.mock("./allowlist.js", () => ({
  normalizeMatrixUserId: (value: string) => value,
}));

vi.mock("./auto-join.js", () => ({
  registerMatrixAutoJoin: vi.fn(),
}));

vi.mock("./direct.js", () => ({
  createDirectRoomTracker: vi.fn(() => ({
    isDirectMessage: vi.fn(async () => false),
  })),
}));

vi.mock("./events.js", () => ({
  registerMatrixMonitorEvents: vi.fn(() => {
    hoisted.callOrder.push("register-events");
  }),
}));

vi.mock("./handler.js", () => ({
  createMatrixRoomMessageHandler: hoisted.createMatrixRoomMessageHandler,
}));

vi.mock("./legacy-crypto-restore.js", () => ({
  maybeRestoreLegacyMatrixBackup: vi.fn(),
}));

vi.mock("./room-info.js", () => ({
  createMatrixRoomInfoResolver: vi.fn(() => ({
    getRoomInfo: vi.fn(async () => ({
      altAliases: [],
    })),
    getMemberDisplayName: vi.fn(async () => "Bot"),
  })),
}));

vi.mock("./startup-verification.js", () => ({
  ensureMatrixStartupVerification: vi.fn(),
}));

describe("monitorMatrixProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    hoisted.callOrder.length = 0;
    hoisted.startClientError = null;
    hoisted.resolveTextChunkLimit.mockReset().mockReturnValue(4000);
    hoisted.releaseSharedClientInstance.mockReset().mockResolvedValue(true);
    hoisted.setActiveMatrixClient.mockReset();
    hoisted.stopThreadBindingManager.mockReset();
    hoisted.client.hasPersistedSyncState.mockReset().mockReturnValue(false);
    hoisted.createMatrixRoomMessageHandler.mockReset().mockReturnValue(vi.fn());
    Object.values(hoisted.logger).forEach((mock) => mock.mockReset());
  });

  it("registers Matrix thread bindings before starting the client", async () => {
    const { monitorMatrixProvider } = await import("./index.js");
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.callOrder).toEqual([
      "prepare-client",
      "create-manager",
      "register-events",
      "start-client",
    ]);
    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
  });

  it("resolves text chunk limit for the effective Matrix account", async () => {
    const { monitorMatrixProvider } = await import("./index.js");
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.resolveTextChunkLimit).toHaveBeenCalledWith(
      expect.anything(),
      "matrix",
      "default",
    );
  });

  it("cleans up thread bindings and shared clients when startup fails", async () => {
    const { monitorMatrixProvider } = await import("./index.js");
    hoisted.startClientError = new Error("start failed");

    await expect(monitorMatrixProvider()).rejects.toThrow("start failed");

    expect(hoisted.stopThreadBindingManager).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledTimes(1);
    expect(hoisted.releaseSharedClientInstance).toHaveBeenCalledWith(hoisted.client, "persist");
    expect(hoisted.setActiveMatrixClient).toHaveBeenNthCalledWith(1, hoisted.client, "default");
    expect(hoisted.setActiveMatrixClient).toHaveBeenNthCalledWith(2, null, "default");
  });

  it("disables cold-start backlog dropping only when sync state is cleanly persisted", async () => {
    hoisted.client.hasPersistedSyncState.mockReturnValue(true);
    const { monitorMatrixProvider } = await import("./index.js");
    const abortController = new AbortController();
    abortController.abort();

    await monitorMatrixProvider({ abortSignal: abortController.signal });

    expect(hoisted.createMatrixRoomMessageHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        dropPreStartupMessages: false,
      }),
    );
  });
});
