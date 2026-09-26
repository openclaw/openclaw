import { DatabaseSync, StatementSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "../../types.js";
import { getMatrixMonitorIndexTestHarness } from "./index.test-helpers.js";

const harness = getMatrixMonitorIndexTestHarness();
let monitorMatrixProvider: typeof import("./index.js").monitorMatrixProvider;
let getMatrixRuntime: typeof import("../../runtime.js").getMatrixRuntime;
let credentials: typeof import("../credentials-read.js");
let installMatrixTestRuntime: typeof import("../../test-runtime.js").installMatrixTestRuntime;

beforeAll(async () => {
  vi.doUnmock("../accounts.js");
  vi.doUnmock("../../runtime.js");
  vi.doUnmock("./handler.js");
  ({ installMatrixTestRuntime } = await import("../../test-runtime.js"));
  ({ getMatrixRuntime } = await import("../../runtime.js"));
  credentials = await import("../credentials-read.js");
  ({ monitorMatrixProvider } = await import("./index.js"));
});

describe("Matrix monitor credential discovery", () => {
  let cfg: CoreConfig;
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
    harness.registeredOnRoomMessage = null;
    harness.client.removeAllListeners();
    Object.assign(harness.client, { getUserId: async () => "@bot:example.org" });
    const stateDir = tempDirs.make("matrix-monitor-credentials-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    cfg = {
      channels: {
        matrix: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "synthetic-main-token",
          allowBots: false,
          accounts: {
            ops: { homeserver: "https://matrix.example.org", accessToken: "synthetic-ops-token" },
          },
        },
      },
    };
    installMatrixTestRuntime({
      stateDir,
      cfg,
      logging: { getChildLogger: () => harness.logger, shouldLogVerbose: () => true },
      channel: {
        mentions: {
          buildMentionRegexes: () => [],
          matchesMentionPatterns: () => false,
          matchesMentionWithExplicit: () => false,
          implicitMentionKindWhen,
          resolveInboundMentionDecision,
        },
      },
    });
    Object.assign(getMatrixRuntime(), { system: { formatNativeDependencyHint: () => "" } });
    credentials.openMatrixCredentialsStore().register("account:ops", {
      accountId: "ops",
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "synthetic-ops-token",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it.each(["matching", "changed-token", "changed-homeserver", "revoked"])(
    "uses %s credentials for real bot ingress without host SQLite",
    async (kind) => {
      if (kind === "revoked") {
        credentials.openMatrixCredentialsStore().register("account:ops", {
          accountId: "ops",
          kind: "revoked",
          revokedAt: "2026-09-02T00:00:00.000Z",
        });
      } else if (kind !== "matching") {
        const stored = credentials.loadMatrixCredentials(undefined, "ops");
        if (!stored) {
          throw new Error("missing seeded credential");
        }
        credentials.openMatrixCredentialsStore().register("account:ops", {
          ...stored,
          accountId: "ops",
          ...(kind === "changed-token"
            ? { accessToken: "synthetic-replacement-token" }
            : { homeserver: "https://other.example.org" }),
        });
      }
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
        expect(harness.registeredOnRoomMessage).not.toBeNull();
        await harness.registeredOnRoomMessage?.("!room:example.org", {
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
          expect(harness.logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("no allowlist"),
          );
        }
        expect(harness.inboundReplayClaim.commit).toHaveBeenCalledOnce();
        expect(harness.logger.error).not.toHaveBeenCalled();
        console.log(
          "matrix-monitor bot discovery host SQL",
          kind,
          sql.map((spy) => spy.mock.calls.length),
        );
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
    const accounts = cfg.channels?.matrix?.accounts;
    if (!accounts) {
      throw new Error("missing synthetic Matrix accounts");
    }
    accounts.secondary = {
      homeserver: "https://matrix.example.org",
      accessToken: "synthetic-secondary-token",
    };
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
      expect(harness.registeredOnRoomMessage).toBeNull();
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
});
