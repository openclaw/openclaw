import { vi } from "vitest";
import type { MatrixRoomInfo } from "./room-info.js";

export type DirectRoomTrackerOptions = NonNullable<
  Parameters<typeof import("./direct.js").createDirectRoomTracker>[1]
>;

type MonitorRetirement = {
  closeTaskAdmission: () => void;
  detachListeners: () => void;
  waitForTasks: () => Promise<void>;
  cleanup: () => Promise<void> | void;
};

const hoisted = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  const callOrder: string[] = [];
  const state = {
    leaseAbortController: new AbortController(),
    monitorRetirement: null as MonitorRetirement | null,
    monitorRetirementPromise: null as Promise<void> | null,
    startClientError: null as Error | null,
  };
  const accountConfig = {
    dm: {},
  };
  const ingress = {
    admitSync: vi.fn(async () => {}),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  const createMatrixIngressMonitor = vi.fn(
    (params: {
      dispatch: (roomId: string, event: unknown, lifecycle: unknown) => Promise<void>;
    }) => {
      hoisted.registeredOnRoomMessage = (roomId, event) => params.dispatch(roomId, event, {});
      return ingress;
    },
  );
  const client = Object.assign(new EventEmitter(), {
    id: "matrix-client",
    bindSyncIngress: vi.fn(async () => () => {}),
    drainPendingDecryptions: vi.fn(async () => undefined),
  });
  const createMatrixRoomMessageHandler = vi.fn(() => vi.fn());
  const createDirectRoomTracker = vi.fn(
    (_clientForTest: unknown, _opts?: DirectRoomTrackerOptions) => ({
      isDirectMessage: vi.fn(async () => false),
    }),
  );
  const getRoomInfo = vi.fn<
    (roomId: string, opts?: { includeAliases?: boolean }) => Promise<MatrixRoomInfo>
  >(async () => ({
    altAliases: [],
    nameResolved: true,
    aliasesResolved: true,
  }));
  const getMemberDisplayName = vi.fn(async () => "Bot");
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const stopThreadBindingManager = vi.fn();
  const createThreadBindingManager = vi.fn(async () => {
    callOrder.push("create-manager");
    return {
      accountId: "default",
      stop: stopThreadBindingManager,
    };
  });
  const disposeAutoJoin = vi.fn(() => {
    callOrder.push("dispose-auto-join");
  });
  const disposeMonitorEvents = vi.fn(() => {
    callOrder.push("dispose-monitor-events");
  });
  const acquireSharedMatrixClientImpl = async () => {
    callOrder.push("prepare-client");
    return lease;
  };
  const registerMonitorRetirement = vi.fn((retirement: MonitorRetirement) => {
    state.monitorRetirement = retirement;
    state.monitorRetirementPromise = null;
  });
  const runRegisteredMonitorRetirement = (): Promise<void> => {
    if (state.monitorRetirementPromise) {
      return state.monitorRetirementPromise;
    }
    state.monitorRetirementPromise = (async () => {
      const retirement = state.monitorRetirement;
      retirement?.closeTaskAdmission();
      retirement?.detachListeners();
      await retirement?.waitForTasks();
      await retirement?.cleanup();
    })();
    return state.monitorRetirementPromise;
  };
  const finalReleaseImpl = async () => {
    await runRegisteredMonitorRetirement();
  };
  const resolveSharedMatrixClientImpl = async () => {
    if (!callOrder.includes("create-manager")) {
      throw new Error("Matrix client started before thread bindings were registered");
    }
    if (!state.monitorRetirement) {
      throw new Error("Matrix client started before monitor retirement was registered");
    }
    if (state.startClientError) {
      throw state.startClientError;
    }
    callOrder.push("start-client");
    return client;
  };
  const acquireSharedMatrixClient = vi.fn(acquireSharedMatrixClientImpl);
  const releaseSharedClientInstance = vi.fn(finalReleaseImpl);
  const lease = {
    get abortSignal() {
      return state.leaseAbortController.signal;
    },
    client,
    role: "monitor" as const,
    registerMonitorRetirement,
    start: vi.fn(resolveSharedMatrixClientImpl),
    release: releaseSharedClientInstance,
  };
  const registerMatrixAutoJoin = vi.fn(() => disposeAutoJoin);
  const registerMatrixMonitorEvents = vi.fn(
    (_params: {
      getHealthySyncSinceMs?: () => number | undefined;
      runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
    }) => {
      callOrder.push("register-events");
      return disposeMonitorEvents;
    },
  );
  const registerChannelRuntimeContext = vi.fn();
  const setMatrixRuntime = vi.fn();
  const backfillMatrixAuthDeviceIdAfterStartup = vi.fn(async () => undefined);
  const runMatrixStartupMaintenance = vi.fn<
    (params: { abortSignal?: AbortSignal }) => Promise<void>
  >(async () => undefined);
  const setStatus = vi.fn();
  return {
    accountConfig,
    acquireSharedMatrixClient,
    acquireSharedMatrixClientImpl,
    backfillMatrixAuthDeviceIdAfterStartup,
    callOrder,
    client,
    createDirectRoomTracker,
    createMatrixIngressMonitor,
    ingress,
    createMatrixRoomMessageHandler,
    createThreadBindingManager,
    disposeAutoJoin,
    disposeMonitorEvents,
    finalReleaseImpl,
    getMemberDisplayName,
    getRoomInfo,
    logger,
    registeredHealthySyncGetter: undefined as undefined | (() => number | undefined),
    registeredOnRoomMessage: null as null | ((roomId: string, event: unknown) => Promise<void>),
    registerChannelRuntimeContext,
    registerMatrixAutoJoin,
    registerMatrixMonitorEvents,
    registerMonitorRetirement,
    releaseSharedClientInstance,
    resolveSharedMatrixClient: lease.start,
    resolveSharedMatrixClientImpl,
    runMatrixStartupMaintenance,
    runRegisteredMonitorRetirement,
    setMatrixRuntime,
    setStatus,
    state,
    stopThreadBindingManager,
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime-context", () => ({
  registerChannelRuntimeContext: hoisted.registerChannelRuntimeContext,
}));

vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { room: "room" },
  resolveAllowlistProviderRuntimeGroupPolicy: () => ({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  }),
  resolveDefaultGroupPolicy: () => "allowlist",
  warnMissingProviderGroupPolicyFallbackOnce: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/thread-bindings-runtime", () => ({
  resolveThreadBindingIdleTimeoutMsForChannel: () => 24 * 60 * 60 * 1000,
  resolveThreadBindingMaxAgeMsForChannel: () => 0,
}));

vi.mock("../../resolve-targets.js", () => ({
  resolveMatrixTargets: vi.fn(async () => []),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => ({
    config: {
      current: () => ({
        channels: {
          matrix: hoisted.accountConfig,
        },
      }),
      replaceConfigFile: vi.fn(),
      mutateConfigFile: vi.fn(),
    },
    logging: {
      getChildLogger: () => hoisted.logger,
      shouldLogVerbose: () => false,
    },
    channel: {
      mentions: {
        buildMentionRegexes: () => [],
      },
    },
    system: {
      formatNativeDependencyHint: () => "",
    },
    media: {
      loadWebMedia: vi.fn(),
    },
  }),
  setMatrixRuntime: hoisted.setMatrixRuntime,
}));

vi.mock("../accounts.js", async () => {
  const actual = await vi.importActual<typeof import("../accounts.js")>("../accounts.js");
  return {
    ...actual,
    resolveConfiguredMatrixBotUserIds: vi.fn(() => new Set<string>()),
    resolveMatrixAccount: () => ({
      accountId: "default",
      config: hoisted.accountConfig,
    }),
  };
});

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: hoisted.acquireSharedMatrixClient,
  backfillMatrixAuthDeviceIdAfterStartup: hoisted.backfillMatrixAuthDeviceIdAfterStartup,
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
}));

vi.mock("../config-update.js", () => ({
  updateMatrixAccountConfig: vi.fn((cfg: unknown) => cfg),
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
  createMatrixThreadBindingManager: hoisted.createThreadBindingManager,
}));

vi.mock("./allowlist.js", () => ({
  normalizeMatrixUserId: (value: string) => value,
}));

vi.mock("./auto-join.js", () => ({
  registerMatrixAutoJoin: hoisted.registerMatrixAutoJoin,
}));

vi.mock("./direct.js", () => ({
  createDirectRoomTracker: hoisted.createDirectRoomTracker,
}));

// mock-isolation: Exercise monitor retirement with fixture-owned event listeners.
vi.mock("./events.js", () => ({
  registerMatrixMonitorEvents: hoisted.registerMatrixMonitorEvents.mockImplementation(
    (params: {
      getHealthySyncSinceMs?: () => number | undefined;
      runDetachedTask?: (label: string, task: () => Promise<void>) => Promise<void>;
    }) => {
      hoisted.callOrder.push("register-events");
      hoisted.registeredHealthySyncGetter = params.getHealthySyncSinceMs;
      return hoisted.disposeMonitorEvents;
    },
  ),
}));

vi.mock("./handler.js", () => ({
  createMatrixRoomMessageHandler: hoisted.createMatrixRoomMessageHandler,
}));

// mock-isolation: Lifecycle tests use in-memory ingress without opening SQLite.
vi.mock("./ingress.js", () => ({
  createMatrixIngressMonitor: hoisted.createMatrixIngressMonitor,
}));

vi.mock("./room-info.js", () => ({
  createMatrixRoomInfoResolver: vi.fn(() => ({
    getRoomInfo: hoisted.getRoomInfo,
    getMemberDisplayName: hoisted.getMemberDisplayName,
  })),
}));

vi.mock("./startup-verification.js", () => ({
  ensureMatrixStartupVerification: vi.fn(),
}));

vi.mock("./startup.js", () => ({
  runMatrixStartupMaintenance: hoisted.runMatrixStartupMaintenance,
}));

export function getMatrixMonitorIndexTestHarness() {
  return hoisted;
}
