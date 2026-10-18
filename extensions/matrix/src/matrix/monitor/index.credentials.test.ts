import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { getMatrixMonitorIndexTestHarness } from "./index.test-helpers.js";

const harness = getMatrixMonitorIndexTestHarness();
function matrixAccount(accessToken: string) {
  return { homeserver: "https://matrix.example.org", accessToken };
}
const storedCredential = {
  ...matrixAccount("synthetic-ops-token"),
  accountId: "ops",
  userId: "@ops:example.org",
  createdAt: "2026-09-01T00:00:00.000Z",
};
vi.doUnmock("../accounts.js");
vi.doUnmock("../../runtime.js");
vi.doUnmock("./handler.js");
const { installMatrixTestRuntime } = await import("../../test-runtime.js");
const { getMatrixRuntime } = await import("../../runtime.js");
const credentials = await import("../credentials-read.js");
const { monitorMatrixProvider } = await import("./index.js");

let accounts: Record<string, ReturnType<typeof matrixAccount>>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeEach(() => {
  vi.clearAllMocks();
  harness.callOrder.length = 0;
  harness.state.leaseAbortController = new AbortController();
  harness.state.monitorRetirement = null;
  harness.state.monitorRetirementPromise = null;
  harness.callbacks.roomMessage = null;
  harness.client.removeAllListeners();
  Object.assign(harness.client, { getUserId: async () => "@bot:example.org" });
  const stateDir = tempDirs.make("matrix-monitor-credentials-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  accounts = { ops: matrixAccount("synthetic-ops-token") };
  installMatrixTestRuntime({
    stateDir,
    cfg: { channels: { matrix: { allowBots: false, accounts } } } satisfies CoreConfig,
    logging: { getChildLogger: () => harness.logger, shouldLogVerbose: () => true },
  });
  Object.assign(getMatrixRuntime(), { system: { formatNativeDependencyHint: () => "" } });
  credentials.openMatrixCredentialsStore().register("account:ops", storedCredential);
});

it.each([
  ["matching", storedCredential],
  ["changed-token", { ...storedCredential, accessToken: "synthetic-replacement-token" }],
  ["changed-homeserver", { ...storedCredential, homeserver: "https://other.example.org" }],
  ["revoked", { accountId: "ops", kind: "revoked", revokedAt: "2026-09-02T00:00:00.000Z" }],
] as const)(
  "uses %s credentials for real bot ingress without host SQLite",
  async (kind, credential) => {
    credentials.openMatrixCredentialsStore().register("account:ops", credential);
    await closeOpenClawStateDatabaseAsync();
    const started = createDeferred<void>();
    harness.resolveSharedMatrixClient.mockImplementationOnce(async () => {
      const client = await harness.resolveSharedMatrixClientImpl();
      started.resolve();
      return client;
    });
    const sql = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    const controller = new AbortController();
    const monitoring = monitorMatrixProvider({ abortSignal: controller.signal });
    try {
      await Promise.race([
        started.promise,
        monitoring.then(() => {
          throw new Error("monitor stopped before startup");
        }),
      ]);
      expect(harness.callbacks.roomMessage).not.toBeNull();
      await harness.callbacks.roomMessage?.("!room:example.org", {
        type: "m.room.message",
        event_id: "$synthetic-bot",
        sender: "@ops:example.org",
        content: { msgtype: "m.text", body: "synthetic bot message" },
      });
      const botDrop = expect.stringContaining("drop configured bot sender=@ops:example.org");
      if (kind === "matching") {
        expect(harness.logger.debug).toHaveBeenCalledWith(botDrop);
      } else {
        expect(harness.logger.debug).not.toHaveBeenCalledWith(botDrop);
        expect(harness.logger.debug).toHaveBeenCalledWith(expect.stringContaining("no allowlist"));
      }
      expect(harness.inboundReplayClaim.commit).toHaveBeenCalledOnce();
      expect(harness.logger.error).not.toHaveBeenCalled();
      for (const spy of sql) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      controller.abort();
      await monitoring;
    }
  },
);
it("joins admitted credential discovery after abort without starting a client", async () => {
  accounts.secondary = matrixAccount("synthetic-secondary-token");
  const observed = createDeferred<void>();
  const release = createDeferred<void>();
  const read = credentials.loadMatrixCredentialsAsync;
  const lookup = vi
    .spyOn(credentials, "loadMatrixCredentialsAsync")
    .mockImplementation(async (...args) => {
      const stored = await read(...args);
      observed.resolve();
      await release.promise;
      return stored;
    });
  const controller = new AbortController();
  const monitoring = monitorMatrixProvider({ abortSignal: controller.signal });
  let settled = false;
  void monitoring.then(() => {
    settled = true;
  });
  try {
    await observed.promise;
    controller.abort();
    await setImmediate();
    expect(settled).toBe(false);
    expect(harness.acquireSharedMatrixClient).not.toHaveBeenCalled();
    expect(harness.callbacks.roomMessage).toBeNull();
  } finally {
    release.resolve();
    controller.abort();
    await monitoring;
  }
  expect(lookup.mock.calls.map(([, accountId]) => accountId)).toEqual(["ops"]);
  expect(harness.acquireSharedMatrixClient).not.toHaveBeenCalled();
  expect(harness.registerMatrixMonitorEvents).not.toHaveBeenCalled();
  expect(harness.resolveSharedMatrixClient).not.toHaveBeenCalled();
});
