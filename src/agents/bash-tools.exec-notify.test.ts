import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
import * as handoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot as setConfig } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig as Config } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration as rotateLifecycle } from "../infra/agent-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { withAgentDatabasePreparationContext } from "../state/agent-database-preparation-context.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  addSession,
  deleteSession,
  markBackgrounded,
  markExited,
  processSessionInstanceId,
} from "./bash-process-registry.js";
import { createProcessSessionFixture as processFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import {
  maybeNotifyOnExit,
  prepareExecExitNotification,
  recoverExecExitNotifications,
} from "./bash-tools.exec-notify.js";
import { createProcessTool } from "./bash-tools.process.js";
import { isRuntimeToolAllowed } from "./tool-policy-match.js";
import { attachToolAllowlistIntersection } from "./tool-policy-shared.js";
import { withGatewayToolCallerIdentity as withCaller } from "./tools/gateway-caller-context.js";

const sessionKey = "agent:main:exec-restart";
const initialConfig: Config = { agents: { entries: { main: {} } } };
const agentNotifications = (main: boolean, secondary?: boolean): Config["agents"] => ({
  entries: {
    main: { tools: { exec: { notifyOnExit: main } } },
    ...(secondary === undefined
      ? {}
      : { secondary: { tools: { exec: { notifyOnExit: secondary } } } }),
  },
});
const route = { channel: "telegram", to: "-100001", accountId: "synthetic-account" };
const completed: SessionEventOutcome = {
  status: "completed",
  executionStarted: true,
  delivered: false,
};
const enqueue = vi.spyOn(handoff, "enqueueSessionEventForHost");
const settlements: Array<ReturnType<typeof createDeferredCore<SessionEventOutcome>>> = [];
let executionCounter = 0;

beforeEach(() => {
  enqueue.mockReset();
  enqueue.mockImplementation(() => {
    const settlement = createDeferredCore<SessionEventOutcome>();
    settlements.push(settlement);
    return {
      id: `receipt-${settlements.length}`,
      cancel: () => true,
      accepted: Promise.resolve({ ok: true }),
      settled: settlement.promise,
    } satisfies SessionEventReceipt;
  });
});

afterAll(() => enqueue.mockRestore());

async function withFixture(
  run: (fixture: {
    config: Config;
    read: () => Promise<SessionEntry | undefined>;
    patch: (entry: Partial<SessionEntry>) => Promise<unknown>;
    background: (options?: {
      notifyOnExit?: boolean;
      id?: string;
      toolsAllow?: string[];
    }) => Promise<ReturnType<typeof processFixture>>;
    recover: (config?: Config) => Promise<void>;
  }) => Promise<void>,
  entry: Partial<SessionEntry> = {},
  owner = { agentId: "main", storeAgentId: "main" },
) {
  await withOpenClawTestState({ label: "exec-restart-notification" }, async (state) => {
    const { agentId, storeAgentId } = owner;
    const key = `agent:${agentId}:exec-restart`;
    setConfig(initialConfig);
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({
      agentId: storeAgentId,
      path: agentId === storeAgentId ? undefined : state.path("shared.sqlite"),
      env: state.env,
    });
    const config: Config =
      agentId === storeAgentId
        ? initialConfig
        : {
            agents: { entries: { [storeAgentId]: {}, [agentId]: {} } },
            session: { store: database.path },
          };
    setConfig(config);
    writeSessionEntry(database, key, {
      sessionId: "original-session",
      lifecycleRevision: "original-revision",
      updatedAt: 1,
      permissionMode: "full",
      delivery: normalizeSessionDeliveryState({ context: route }),
      ...entry,
    });
    const scope = {
      agentId: storeAgentId,
      sessionKey: key,
      env: state.env,
      storePath: resolveSessionStorePathCore(config.session?.store, {
        agentId: storeAgentId,
        env: state.env,
      }),
    };
    try {
      await run({
        config,
        read: () => readSessionEntryReadOnlyInWorker(scope),
        patch: (patch) => patchSessionEntryCore(scope, () => patch, { preserveActivity: true }),
        background: async (options = {}) => {
          const process = processFixture({
            id: options.id ?? `synthetic-execution-${++executionCounter}`,
            command: "SECRET_TOKEN=synthetic-secret private-command --secret synthetic-secret",
            startedAt: 123,
          });
          Object.assign(process, {
            agentId,
            sessionKey: key,
            notifyOnExit: options.notifyOnExit ?? true,
            notifyOnExitEmptySuccess: true,
          });
          addSession(process);
          await withCaller(
            { agentId, sessionKey: key, sessionEventToolsAllow: options.toolsAllow },
            () => prepareExecExitNotification(process, false),
          );
          markBackgrounded(process);
          await process.exitNotificationPersistence;
          return process;
        },
        recover: (recoveryConfig = config) =>
          recoverExecExitNotifications(recoveryConfig, new AbortController().signal),
      });
    } finally {
      resetProcessRegistryForTests();
      for (const settlement of settlements.splice(0)) {
        settlement.resolve(completed);
        await settlement.promise;
      }
      // Finish the notification owner's settled/finally handlers before fixture teardown.
      await Promise.resolve();
      await Promise.resolve();
    }
  });
}

function lastNotification() {
  const call = enqueue.mock.calls.at(-1);
  if (!call) {
    throw new Error("Expected a completion handoff");
  }
  return { text: call[0], options: call[1] };
}

describe("background exec completion obligations", () => {
  it("rescans stores after admission completes", () =>
    withFixture(async ({ background, recover, read }) => {
      await background();
      rotateLifecycle();
      const refusal = createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: [resolveSessionStorePathCore(undefined, { agentId: "main" })],
        reason: "synthetic pending unclean-close inspection",
        pending: true,
      });
      recordAgentDatabaseAdmissions([refusal]);
      const joined = createDeferredCore();
      const prepared = createDeferredCore();
      const recovery = withAgentDatabasePreparationContext(
        () => ({
          waitForAgentPreparation: () => {
            joined.resolve();
            return prepared.promise;
          },
        }),
        () => recover(),
      );
      try {
        await Promise.race([joined.promise, recovery]);
        expect(enqueue).not.toHaveBeenCalled();
        await preparePendingAgentDatabase(refusal, { assertCurrent: () => {} }, async () => {});
        prepared.resolve();
        await recovery;
        expect(enqueue).toHaveBeenCalledTimes(1);
        await lastNotification().options.onAdopted?.();
        await recover();
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect((await read())?.pendingExecNotifications).toBeUndefined();
      } finally {
        prepared.resolve();
        await recovery;
        recordAgentDatabaseAdmissions([]);
      }
    }));

  it("persists only notification metadata", () =>
    withFixture(async ({ background, read }) => {
      const process = await background();
      const entry = await read();
      expect(entry?.pendingExecNotifications).toEqual({
        [processSessionInstanceId(process)]: {
          processSessionId: process.id,
          sessionId: "original-session",
          lifecycleRevision: "original-revision",
          incarnation: process.notifySessionTarget?.generation,
          startedAt: 123,
          label: "background exec",
          policy: { settings: { permissionMode: "full" }, deliveryContext: route },
        },
      });
      expect(JSON.stringify(entry?.pendingExecNotifications)).not.toContain("synthetic-secret");
      expect(entry?.updatedAt).toBe(1);
      expect(enqueue).not.toHaveBeenCalled();
    }));

  it("retains completion until adoption", () =>
    withFixture(async ({ background, read }) => {
      const process = await background();
      process.exitCode = 0;
      await maybeNotifyOnExit(process, "completed", false);
      expect((await read())?.pendingExecNotifications).toHaveProperty(
        processSessionInstanceId(process),
      );
      const notification = lastNotification();
      expect(notification.text).toContain("Exec completed");
      expect(notification.options.expectedTarget).toBe(process.notifySessionTarget);
      await notification.options.onAdopted?.();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
    }));

  it.each(["cancelled", "removed"] as const)("clears explicitly %s processes", (action) =>
    withFixture(async ({ background, read }) => {
      const process = await background();
      if (action === "cancelled") {
        process.exitReason = "manual-cancel";
        await maybeNotifyOnExit(process, "failed", false);
      } else {
        markExited(process, 0, null, "completed");
        const result = await createProcessTool().execute("remove", {
          action: "remove",
          sessionId: process.id,
        });
        expect(result.details).toMatchObject({ status: "completed" });
      }
      expect((await read())?.pendingExecNotifications).toBeUndefined();
      expect(enqueue).not.toHaveBeenCalled();
    }),
  );

  it("recovers a lost exec once after adoption", () =>
    withFixture(async ({ background, read, recover }) => {
      const process = await background();
      await recover();
      expect(enqueue).not.toHaveBeenCalled();
      rotateLifecycle();
      await recover();
      await recover();
      expect(enqueue).toHaveBeenCalledTimes(1);
      const { text, options } = lastNotification();
      expect(text).toContain(
        "the process was lost when the Gateway restarted; its outcome is unknown",
      );
      expect(text).toContain("Check the process's side effects/state before re-running it");
      expect(text).not.toContain("synthetic-secret");
      expect(options).toMatchObject({
        agentId: "main",
        sessionKey,
        source: "exec",
        contextKey: `exec:${processSessionInstanceId(process)}`,
        sourceTurnId: `exec:${processSessionInstanceId(process)}`,
        expectedTarget: { sessionId: "original-session", lifecycleRevision: "original-revision" },
      });
      await options.onAdopted?.();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
      rotateLifecycle();
      await recover();
      expect(enqueue).toHaveBeenCalledTimes(1);
    }));

  it("distinguishes receipts with reused slug and start time", () =>
    withFixture(async ({ background, read }) => {
      const first = await background({ id: "reused-process" });
      await maybeNotifyOnExit(first, "completed", false);
      const firstNotification = lastNotification();
      await firstNotification.options.onAdopted?.();
      deleteSession(first.id);
      await first.clearExitNotification?.();
      const successor = await background({ id: first.id });
      await maybeNotifyOnExit(successor, "completed", false);
      const successorNotification = lastNotification();
      expect(successor.startedAt).toBe(first.startedAt);
      expect(successorNotification.options.sourceTurnId).not.toBe(
        firstNotification.options.sourceTurnId,
      );
      expect(Object.keys((await read())?.pendingExecNotifications ?? {})).toEqual([
        processSessionInstanceId(successor),
      ]);
      await successorNotification.options.onAdopted?.();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
    }));

  it.each<{
    name: string;
    patch?: (source: string) => Partial<SessionEntry>;
    config?: Config;
  }>([
    {
      name: "claimed source",
      patch: (source) => ({
        restartRecoveryDeliveryRunId: "admitted-notice-run",
        restartRecoveryDeliverySourceRunId: source,
      }),
    },
    { name: "terminal source", patch: (source) => ({ restartRecoveryTerminalRunIds: [source] }) },
    { name: "replaced session", patch: () => ({ sessionId: "replacement-session" }) },
    { name: "reset session", patch: () => ({ lifecycleRevision: "replacement-revision" }) },
    { name: "archived session", patch: () => ({ archivedAt: 5 }) },
    {
      name: "global opt-out",
      config: { ...initialConfig, tools: { exec: { notifyOnExit: false } } },
    },
    { name: "agent opt-out", config: { agents: agentNotifications(false) } },
  ])("clears a $name without waking it", ({ patch, config }) =>
    withFixture(async ({ background, patch: patchEntry, read, recover }) => {
      const process = await background();
      if (patch) {
        await patchEntry(patch(`exec:${processSessionInstanceId(process)}`));
      }
      if (config) {
        setConfig(config);
      }
      rotateLifecycle();
      await recover(config);
      expect(enqueue).not.toHaveBeenCalled();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
    }),
  );

  it.each([
    { main: true, secondary: true },
    { main: false, secondary: true },
    { main: true, secondary: false },
  ])("uses the logical agent in a shared store (main=$main, secondary=$secondary)", (notify) =>
    withFixture(
      async ({ background, read, recover, config }) => {
        const process = await background();
        expect((await read())?.pendingExecNotifications).toHaveProperty(
          processSessionInstanceId(process),
        );
        const recoveryConfig: Config = {
          ...config,
          agents: agentNotifications(notify.main, notify.secondary),
        };
        setConfig(recoveryConfig);
        rotateLifecycle();
        await recover(recoveryConfig);
        if (notify.secondary) {
          expect(enqueue).toHaveBeenCalledTimes(1);
          const { options } = lastNotification();
          expect(options).toMatchObject({
            agentId: "secondary",
            sessionKey: "agent:secondary:exec-restart",
            expectedTarget: {
              agentId: "secondary",
              sessionId: "original-session",
              lifecycleRevision: "original-revision",
            },
          });
          expect(() => options.assertCurrent?.()).not.toThrow();
          setConfig({
            ...recoveryConfig,
            agents: agentNotifications(true, false),
          });
          expect(() => options.assertCurrent?.()).toThrow("notifications are disabled");
          await options.onAdopted?.();
        } else {
          expect(enqueue).not.toHaveBeenCalled();
        }
        expect((await read())?.pendingExecNotifications).toBeUndefined();
      },
      {},
      { agentId: "secondary", storeAgentId: "main" },
    ),
  );

  it.each([
    { name: "disabled notification", options: { notifyOnExit: false }, entry: {} },
    { name: "incognito session", options: {}, entry: { incognito: true } },
  ])("does not record a restart obligation for a $name", ({ options, entry }) =>
    withFixture(async ({ background, read, recover }) => {
      await background(options);
      expect((await read())?.pendingExecNotifications).toBeUndefined();
      rotateLifecycle();
      await recover();
      expect(enqueue).not.toHaveBeenCalled();
    }, entry),
  );

  it("narrows recovery authority and rechecks opt-out before effect", () =>
    withFixture(async ({ background, patch, recover }) => {
      await background();
      await patch({ permissionMode: "read-only" });
      rotateLifecycle();
      await recover();
      const { options } = lastNotification();
      expect(options.expectedTarget?.settings?.permissionMode).toBe("read-only");
      expect(options.assertCurrent).toBeTypeOf("function");
      setConfig({ ...initialConfig, tools: { exec: { notifyOnExit: false } } });
      expect(() => options.assertCurrent?.()).toThrow("notifications are disabled");
    }));

  it("preserves tool intersections through recovery", () =>
    withFixture(async ({ background, read, recover }) => {
      await background({
        toolsAllow: attachToolAllowlistIntersection([], [["read*"], ["*ad"]]),
      });
      expect(
        Object.values((await read())?.pendingExecNotifications ?? {})[0]?.policy.toolsAllow,
      ).toEqual([["read*"], ["*ad"]]);
      rotateLifecycle();
      await recover();
      const toolsAllow = lastNotification().options.expectedTarget?.toolsAllow;
      expect(isRuntimeToolAllowed("read", toolsAllow)).toBe(true);
      expect(isRuntimeToolAllowed("read_secret", toolsAllow)).toBe(false);
      expect(isRuntimeToolAllowed("write", toolsAllow)).toBe(false);
    }));
});
