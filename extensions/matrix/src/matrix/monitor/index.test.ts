import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const callOrder: string[] = [];
  const state = {
    startClientError: null as Error | null,
  };
  const inboundDeduper = {
    claimEvent: vi.fn(() => true),
    commitEvent: vi.fn(async () => undefined),
    releaseEvent: vi.fn(),
    flush: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
  const client = {
    id: "matrix-client",
    hasPersistedSyncState: vi.fn(() => false),
    stopSyncWithoutPersist: vi.fn(),
    drainPendingDecryptions: vi.fn(async () => undefined),
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
    inboundDeduper,
    logger,
    registeredOnRoomMessage: null as null | ((roomId: string, event: unknown) => Promise<void>),
    releaseSharedClientInstance,
    resolveTextChunkLimit,
    setActiveMatrixClient,
    state,
    stopThreadBindingManager,
  };
});

vi.mock("../../runtime-api.js", () => ({
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
  resolveConfiguredMatrixBotUserIds: vi.fn(() => new Set<string>()),
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
    if (hoisted.state.startClientError) {
      throw hoisted.state.startClientError;
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
  registerMatrixMonitorEvents: vi.fn(
    (params: { onRoomMessage: (roomId: string, event: unknown) => Promise<void> }) => {
      hoisted.callOrder.push("register-events");
      hoisted.registeredOnRoomMessage = params.onRoomMessage;
    },
  ),
}));

vi.mock("./handler.js", () => ({
  createMatrixRoomMessageHandler: hoisted.createMatrixRoomMessageHandler,
}));

vi.mock("./inbound-dedupe.js", () => ({
  createMatrixInboundEventDeduper: vi.fn(async () => hoisted.inboundDeduper),
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
    hoisted.state.startClientError = null;
    hoisted.resolveTextChunkLimit.mockReset().mockReturnValue(4000);
    hoisted.releaseSharedClientInstance.mockReset().mockResolvedValue(true);
    hoisted.registeredOnRoomMessage = null;
    hoisted.setActiveMatrixClient.mockReset();
    hoisted.stopThreadBindingManager.mockReset();
    hoisted.client.hasPersistedSyncState.mockReset().mockReturnValue(false);
    hoisted.client.stopSyncWithoutPersist.mockReset();
    hoisted.client.drainPendingDecryptions.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.claimEvent.mockReset().mockReturnValue(true);
    hoisted.inboundDeduper.commitEvent.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.releaseEvent.mockReset();
    hoisted.inboundDeduper.flush.mockReset().mockResolvedValue(undefined);
    hoisted.inboundDeduper.stop.mockReset().mockResolvedValue(undefined);
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
    hoisted.state.startClientError = new Error("start failed");

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

  it("stops sync, drains decryptions, then waits for in-flight handlers before persisting", async () => {
    const { monitorMatrixProvider } = await import("./index.js");
    const abortController = new AbortController();
    let resolveHandler: (() => void) | null = null;

    hoisted.createMatrixRoomMessageHandler.mockReturnValue(
      vi.fn(() => {
        hoisted.callOrder.push("handler-start");
        return new Promise<void>((resolve) => {
          resolveHandler = () => {
            hoisted.callOrder.push("handler-done");
            resolve();
          };
        });
      }),
    );
    hoisted.client.stopSyncWithoutPersist.mockImplementation(() => {
      hoisted.callOrder.push("pause-client");
    });
    hoisted.client.drainPendingDecryptions.mockImplementation(async () => {
      hoisted.callOrder.push("drain-decrypts");
    });
    hoisted.stopThreadBindingManager.mockImplementation(() => {
      hoisted.callOrder.push("stop-manager");
    });
    hoisted.releaseSharedClientInstance.mockImplementation(async () => {
      hoisted.callOrder.push("release-client");
      return true;
    });
    hoisted.inboundDeduper.stop.mockImplementation(async () => {
      hoisted.callOrder.push("stop-deduper");
    });

    const monitorPromise = monitorMatrixProvider({ abortSignal: abortController.signal });
    await vi.waitFor(() => {
      expect(hoisted.callOrder).toContain("start-client");
    });
    const onRoomMessage = hoisted.registeredOnRoomMessage;
    if (!onRoomMessage) {
      throw new Error("expected room message handler to be registered");
    }

    const roomMessagePromise = onRoomMessage("!room:example.org", { event_id: "$event" });
    abortController.abort();
    await vi.waitFor(() => {
      expect(hoisted.callOrder).toContain("pause-client");
    });
    expect(hoisted.callOrder).not.toContain("stop-deduper");

    if (resolveHandler === null) {
      throw new Error("expected in-flight handler to be pending");
    }
    (resolveHandler as () => void)();
    await roomMessagePromise;
    await monitorPromise;

    expect(hoisted.callOrder.indexOf("pause-client")).toBeLessThan(
      hoisted.callOrder.indexOf("drain-decrypts"),
    );
    expect(hoisted.callOrder.indexOf("drain-decrypts")).toBeLessThan(
      hoisted.callOrder.indexOf("handler-done"),
    );
    expect(hoisted.callOrder.indexOf("handler-done")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-manager"),
    );
    expect(hoisted.callOrder.indexOf("stop-manager")).toBeLessThan(
      hoisted.callOrder.indexOf("stop-deduper"),
    );
    expect(hoisted.callOrder.indexOf("stop-deduper")).toBeLessThan(
      hoisted.callOrder.indexOf("release-client"),
    );
  });
});
