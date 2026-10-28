import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getCommandOwnerAuthority } from "../auto-reply/command-owner-authority.js";
import { buildSessionEventContext } from "../auto-reply/reply/session-event-context.js";
import type {
  SessionEventOutcome,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
import * as handoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
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
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import {
  maybeNotifyOnExit,
  prepareExecExitNotification,
  recoverExecExitNotifications,
} from "./bash-tools.exec-notify.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { RequesterOrigin } from "./requester-origin.js";
import { isRuntimeToolAllowed } from "./tool-policy-match.js";
import { attachToolAllowlistIntersection } from "./tool-policy-shared.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

const sessionKey = "agent:main:exec-restart";
const initialConfig: OpenClawConfig = { agents: { entries: { main: {} } } };
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
    config: OpenClawConfig;
    read: () => Promise<InternalSessionEntry | undefined>;
    patch: (entry: Partial<InternalSessionEntry>) => Promise<unknown>;
    background: (options?: {
      notifyOnExit?: boolean;
      id?: string;
      toolsAllow?: string[];
      requesterOrigin?: RequesterOrigin;
    }) => Promise<ReturnType<typeof createProcessSessionFixture>>;
    recover: (config?: OpenClawConfig) => Promise<void>;
  }) => Promise<void>,
  entry: Partial<InternalSessionEntry> = {},
  owner = { agentId: "main", storeAgentId: "main" },
) {
  await withOpenClawTestState({ label: "exec-restart-notification" }, async (state) => {
    const { agentId, storeAgentId } = owner;
    const key = `agent:${agentId}:exec-restart`;
    setRuntimeConfigSnapshot(initialConfig);
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({
      agentId: storeAgentId,
      path: agentId === storeAgentId ? undefined : state.path("shared.sqlite"),
      env: state.env,
    });
    const config: OpenClawConfig =
      agentId === storeAgentId
        ? initialConfig
        : {
            agents: { entries: { [storeAgentId]: {}, [agentId]: {} } },
            session: { store: database.path },
          };
    setRuntimeConfigSnapshot(config);
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
          const process = createProcessSessionFixture({
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
          await withGatewayToolCallerIdentity(
            {
              agentId,
              sessionKey: key,
              sessionEventToolsAllow: options.toolsAllow,
              requesterOrigin: options.requesterOrigin,
            },
            () => prepareExecExitNotification(process, false),
          );
          markBackgrounded(process);
          await process.exitNotificationPersistence;
          return process;
        },
        recover: (recoveryConfig = config) =>
          recoverExecExitNotifications(recoveryConfig, new AbortController().signal).settled,
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
  it("rescans pending stores after their admission owner completes", async () => {
    await withFixture(async ({ background, recover, read }) => {
      await background();
      rotateAgentEventLifecycleGeneration();
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
    });
  });

  it("records a compact durable obligation without command text, environment or output", async () => {
    await withFixture(async ({ background, read }) => {
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
    });
  });

  it("retains the obligation until normal completion is adopted", async () => {
    await withFixture(async ({ background, read }) => {
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
    });
  });

  it.each(["cancelled", "removed"] as const)("clears explicitly %s processes", async (action) => {
    await withFixture(async ({ background, read }) => {
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
    });
  });

  it("hands off an old-incarnation obligation once and does not repeat it after adoption", async () => {
    await withFixture(async ({ background, read, recover }) => {
      const process = await background();
      await recover();
      expect(enqueue).not.toHaveBeenCalled();
      rotateAgentEventLifecycleGeneration();
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
        sourceTurnId: `exec:${processSessionInstanceId(process)}:restart:${getAgentEventLifecycleGeneration()}`,
        expectedTarget: { sessionId: "original-session", lifecycleRevision: "original-revision" },
      });
      await options.onAdopted?.();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
      rotateAgentEventLifecycleGeneration();
      await recover();
      expect(enqueue).toHaveBeenCalledTimes(1);
    });
  });

  it("wakes again after restarts interrupt the accepted completion and restart notice", async () => {
    await withFixture(async ({ background, read, recover }) => {
      const process = await background();
      // Like the session-event handoff: stage under the source turn with a fresh run id,
      // then let a restart interrupt the queued input before adoption.
      const acceptThenInterrupt = async () => {
        const { text, options } = lastNotification();
        const target = options.expectedTarget!;
        const receipt = await stageSessionPendingInput(
          {
            agentId: "main",
            sessionKey: target.sessionKey!,
            sessionId: target.sessionId,
            storePath: target.storePath,
          },
          {
            runId: randomUUID(),
            message: {
              role: "user",
              content: text,
              timestamp: Date.now(),
              idempotencyKey: options.sourceTurnId,
            },
            trackCompletion: true,
            assertCurrent: () => {},
          },
        );
        receipt?.finish("interrupted");
        await receipt?.settled?.();
        settlements.at(-1)?.resolve({
          status: "failed",
          executionStarted: false,
          delivered: false,
          error: "Session event was abandoned before execution",
        });
      };
      process.exitCode = 0;
      await maybeNotifyOnExit(process, "completed", false);
      await acceptThenInterrupt();
      rotateAgentEventLifecycleGeneration();
      await recover();
      await acceptThenInterrupt();
      rotateAgentEventLifecycleGeneration();
      await recover();
      await acceptThenInterrupt();
      expect(enqueue).toHaveBeenCalledTimes(3);
      expect((await read())?.pendingExecNotifications).toHaveProperty(
        processSessionInstanceId(process),
      );
    });
  });

  it("keeps distinct completion receipts when a process slug and start time are reused", async () => {
    await withFixture(async ({ background, read }) => {
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
    });
  });

  it.each(["claimed", "terminal"] as const)(
    "clears an already %s source after a crash before the adoption callback",
    async (phase) => {
      await withFixture(async ({ background, patch, read, recover }) => {
        const process = await background();
        const sourceTurnId = `exec:${processSessionInstanceId(process)}`;
        await patch(
          phase === "claimed"
            ? {
                restartRecoveryDeliveryRunId: "admitted-notice-run",
                restartRecoveryDeliverySourceRunId: sourceTurnId,
              }
            : { restartRecoveryTerminalRunIds: [sourceTurnId] },
        );
        rotateAgentEventLifecycleGeneration();
        await recover();
        expect(enqueue).not.toHaveBeenCalled();
        expect((await read())?.pendingExecNotifications).toBeUndefined();
      });
    },
  );

  it.each([
    { name: "replaced", patch: { sessionId: "replacement-session" } },
    { name: "reset", patch: { lifecycleRevision: "replacement-revision" } },
    { name: "archived", patch: { archivedAt: 5 } },
  ])("clears a $name session without waking it", async ({ patch }) => {
    await withFixture(async ({ background, patch: patchEntry, read, recover }) => {
      await background();
      await patchEntry(patch);
      rotateAgentEventLifecycleGeneration();
      await recover();
      expect(enqueue).not.toHaveBeenCalled();
      expect((await read())?.pendingExecNotifications).toBeUndefined();
    });
  });

  it.each(["global", "agent"] as const)(
    "honors the current %s notification opt-out",
    async (scope) => {
      await withFixture(async ({ background, read, recover }) => {
        await background();
        const config: OpenClawConfig =
          scope === "global"
            ? { ...initialConfig, tools: { exec: { notifyOnExit: false } } }
            : { agents: { entries: { main: { tools: { exec: { notifyOnExit: false } } } } } };
        setRuntimeConfigSnapshot(config);
        rotateAgentEventLifecycleGeneration();
        await recover(config);
        expect(enqueue).not.toHaveBeenCalled();
        expect((await read())?.pendingExecNotifications).toBeUndefined();
      });
    },
  );

  it.each([
    { main: true, secondary: true },
    { main: false, secondary: true },
    { main: true, secondary: false },
  ])(
    "uses the logical agent in a shared store (main=$main, secondary=$secondary)",
    async (notify) => {
      await withFixture(
        async ({ background, read, recover, config }) => {
          const process = await background();
          expect((await read())?.pendingExecNotifications).toHaveProperty(
            processSessionInstanceId(process),
          );
          const recoveryConfig: OpenClawConfig = {
            ...config,
            agents: {
              entries: {
                main: { tools: { exec: { notifyOnExit: notify.main } } },
                secondary: { tools: { exec: { notifyOnExit: notify.secondary } } },
              },
            },
          };
          setRuntimeConfigSnapshot(recoveryConfig);
          rotateAgentEventLifecycleGeneration();
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
            setRuntimeConfigSnapshot({
              ...recoveryConfig,
              agents: {
                entries: {
                  main: { tools: { exec: { notifyOnExit: true } } },
                  secondary: { tools: { exec: { notifyOnExit: false } } },
                },
              },
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
      );
    },
  );

  it("does not persist a process whose completion notification was disabled", async () => {
    await withFixture(async ({ background, read, recover }) => {
      await background({ notifyOnExit: false });
      expect((await read())?.pendingExecNotifications).toBeUndefined();
      rotateAgentEventLifecycleGeneration();
      await recover();
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  it("does not record a restart obligation for an incognito session", async () => {
    await withFixture(
      async ({ background, read, recover }) => {
        await background();
        expect((await read())?.pendingExecNotifications).toBeUndefined();
        rotateAgentEventLifecycleGeneration();
        await recover();
        expect(enqueue).not.toHaveBeenCalled();
      },
      { incognito: true },
    );
  });

  it("narrows recovered tool authority and rechecks opt-out at the effect boundary", async () => {
    await withFixture(async ({ background, patch, recover }) => {
      await background();
      await patch({ permissionMode: "read-only" });
      rotateAgentEventLifecycleGeneration();
      await recover();
      const { options } = lastNotification();
      expect(options.expectedTarget?.settings?.permissionMode).toBe("read-only");
      expect(options.assertCurrent).toBeTypeOf("function");
      setRuntimeConfigSnapshot({ ...initialConfig, tools: { exec: { notifyOnExit: false } } });
      expect(() => options.assertCurrent?.()).toThrow("notifications are disabled");
    });
  });

  it.each([
    ["owner", "456", true],
    ["guest", "789", false],
  ] as const)(
    "gives the completion turn the current owner authority of its %s requester",
    async (_requester, senderId, owner) => {
      const ownerConfig: OpenClawConfig = {
        ...initialConfig,
        channels: { telegram: {} },
        commands: { ownerAllowFrom: ["456"] },
      };
      await withFixture(async ({ background }) => {
        setRuntimeConfigSnapshot(ownerConfig);
        const process = await background({
          requesterOrigin: {
            sessionKey,
            messageProvider: "telegram",
            accountId: route.accountId,
            senderId,
          },
        });
        process.exitCode = 0;
        await maybeNotifyOnExit(process, "completed", false);
        const { text, options } = lastNotification();
        const ctx = buildSessionEventContext({
          cfg: ownerConfig,
          agentId: "main",
          sessionKey: options.sessionKey,
          text,
          options,
          occurrenceId: "completion",
          target: options.expectedTarget!,
          assertCurrent() {},
        });
        expect(getCommandOwnerAuthority(ctx)?.isCurrent() === true).toBe(owner);
        if (owner) {
          // Owner rights are rechecked at use, so removing the owner revokes them.
          setRuntimeConfigSnapshot({ ...ownerConfig, commands: { ownerAllowFrom: ["789"] } });
          expect(getCommandOwnerAuthority(ctx)?.isCurrent()).toBe(false);
        }
      });
    },
  );

  it("preserves intersected tool restrictions through durable recovery", async () => {
    await withFixture(async ({ background, read, recover }) => {
      await background({
        toolsAllow: attachToolAllowlistIntersection([], [["read*"], ["*ad"]]),
      });
      expect(
        Object.values((await read())?.pendingExecNotifications ?? {})[0]?.policy.toolsAllow,
      ).toEqual([["read*"], ["*ad"]]);
      rotateAgentEventLifecycleGeneration();
      await recover();
      const toolsAllow = lastNotification().options.expectedTarget?.toolsAllow;
      expect(isRuntimeToolAllowed("read", toolsAllow)).toBe(true);
      expect(isRuntimeToolAllowed("read_secret", toolsAllow)).toBe(false);
      expect(isRuntimeToolAllowed("write", toolsAllow)).toBe(false);
    });
  });
});
