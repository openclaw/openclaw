import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { onTestFinished, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { MatrixClient } from "../sdk.js";
import type { MatrixClientEventMap } from "../sdk/types.js";
import { registerMatrixMonitorEvents } from "./events.js";
import type { MatrixRawEvent } from "./types.js";

class MonitorEventClient extends MatrixClient {
  emitForTest<K extends keyof MatrixClientEventMap>(event: K, ...args: MatrixClientEventMap[K]) {
    this.emitter.emit(event, ...args);
  }
}

export function createMatrixMonitorEventsTestHarness(params: {
  cfg?: CoreConfig;
  accountId?: string;
  onRoomMessage: (roomId: string, event: MatrixRawEvent) => Promise<void>;
}) {
  const priorFetch = globalThis.fetch;
  const priorDispatcher = getGlobalDispatcher();
  const deniedNetwork = new MockAgent();
  deniedNetwork.disableNetConnect();
  setGlobalDispatcher(deniedNetwork);
  globalThis.fetch = async () => {
    throw new Error("Matrix event fixture forbids network");
  };
  const pendingTasks = new Set<Promise<void>>();
  const flushTasks = async () => {
    while (pendingTasks.size > 0) {
      await Promise.all(pendingTasks);
    }
  };
  let disposeClient = () => Promise.resolve();
  let disposeMonitor = () => {};
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    disposeMonitor();
    disposal ??= (async () => {
      try {
        await flushTasks();
      } finally {
        try {
          await disposeClient();
        } finally {
          globalThis.fetch = priorFetch;
          setGlobalDispatcher(priorDispatcher);
          await deniedNetwork.close();
        }
      }
    })();
    return disposal;
  };
  const dirs = useAutoCleanupTempDirTracker((cleanupDirs) => {
    onTestFinished(async () => {
      try {
        await dispose();
      } finally {
        cleanupDirs();
      }
    });
  });
  const stateDir = dirs.make("matrix-monitor-event-");
  const auth = {
    accountId: params.accountId ?? "ops",
    homeserver: "https://matrix.invalid",
    userId: "@bot:example.org",
    accessToken: "synthetic-no-network",
    deviceId: "SYNTHETIC",
    encryption: false,
  };
  const eventClient = new MonitorEventClient(auth.homeserver, auth.accessToken, {
    userId: auth.userId,
    deviceId: auth.deviceId,
    encryption: false,
    autoBootstrapCrypto: false,
    recoveryKeyPath: path.join(stateDir, "recovery-key.json"),
    idbSnapshotPath: path.join(stateDir, "idb-snapshot.json"),
    cryptoDatabasePrefix: path.join(stateDir, "crypto"),
  });
  disposeClient = () => eventClient.stopWithoutPersist();
  disposeMonitor = registerMatrixMonitorEvents({
    cfg: params.cfg ?? { channels: { matrix: {} } },
    client: eventClient,
    auth,
    allowFrom: ["*"],
    dmEnabled: true,
    dmPolicy: "open",
    readStoreAllowFrom: async () => [],
    directTracker: {
      invalidateRoom: vi.fn(),
      rememberInvite: vi.fn(),
      isDirectMessage: async () => false,
    },
    groupPolicy: "open",
    needsRoomAliasesForConfig: false,
    getRoomInfo: async () => ({ altAliases: [], nameResolved: true, aliasesResolved: true }),
    logVerboseMessage: vi.fn(),
    warnedEncryptedRooms: new Set<string>(),
    warnedCryptoMissingRooms: new Set<string>(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    formatNativeDependencyHint: () => "synthetic dependency hint",
    onRoomMessage: params.onRoomMessage,
    runDetachedTask: (_label, task) => {
      const promise = Promise.resolve()
        .then(task)
        .finally(() => {
          pendingTasks.delete(promise);
        });
      pendingTasks.add(promise);
      return promise;
    },
  });
  return {
    dispose,
    flushTasks,
    roomEventListener: (...args: MatrixClientEventMap["room.event"]) =>
      eventClient.emitForTest("room.event", ...args),
    roomMessageListener: (...args: MatrixClientEventMap["room.message"]) =>
      eventClient.emitForTest("room.message", ...args),
  };
}
