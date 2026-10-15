import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import type { InternalSessionEntry } from "../../config/sessions.js";
import type { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { createMockGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import {
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import * as commandQueue from "../../process/command-queue.js";
import {
  GatewayDrainingError,
  resetGatewayWorkAdmission,
  markGatewayRestartDraining,
} from "../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import * as recoveryStore from "./main-session-recovery-store.js";
import type {
  recoverRestartAbortedMainSessions,
  retryRestartAbortedMainSessionRecovery,
} from "./main-session-restart-recovery.js";

async function runRecoveryCommandDuringStop(params: {
  entry: InternalSessionEntry;
  runId: string;
  sessionKey: string;
  storePath: string;
  stateDir: string;
  signal: AbortSignal;
}): Promise<void> {
  const [
    { getAcpSessionManager },
    { prepareAgentCommandExecutionIdentity },
    { runEmbeddedAgentAttempt },
  ] = await Promise.all([
    import("../../acp/control-plane/manager.js"),
    import("../agent-command-execution-identity.js"),
    import("../command/run-embedded-attempt.js"),
  ]);
  const opts = {
    message: "Resume the interrupted task.",
    abortSignal: params.signal,
    mainRestartRecoveryAdmitted: true,
    mainRestartRecoveryAttempt: params.entry.mainRestartRecovery!.chargedAttempts,
    onActiveModelSelected: () => markGatewayRestartDraining("stop (SIGTERM)"),
  };
  const provider = "anthropic";
  const model = "claude-sonnet-4-6";
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const prepared: Parameters<typeof runEmbeddedAgentAttempt>[0]["prepared"] = {
    opts,
    cfg: {},
    body: opts.message,
    transcriptBody: opts.message,
    configuredThinkingCatalog: [],
    normalizedSpawned: {},
    agentCfg: undefined,
    thinkOverride: undefined,
    thinkOnce: undefined,
    verboseOverride: undefined,
    timeoutMs: 10_000,
    runTimeoutOverrideMs: undefined,
    sessionId: params.entry.sessionId,
    sessionEntry: params.entry,
    sessionStore: { [params.sessionKey]: params.entry },
    sessionKey: params.sessionKey,
    storePath: params.storePath,
    runId: params.runId,
    isNewSession: false,
    previousSessionId: undefined,
    persistedThinking: undefined,
    persistedVerbose: undefined,
    sessionAgentId: "main",
    outboundSession: undefined,
    workspaceDir: params.stateDir,
    cwd: undefined,
    agentDir: path.join(params.stateDir, "agents", "main", "agent"),
    pluginsEnabled: false,
    manifestMetadataSnapshot: undefined,
    modelManifestContext: { manifestPlugins: [] },
    isSubagentLane: false,
    acpManager: getAcpSessionManager(),
    acpResolution: null,
    runLease: undefined,
  };
  const admission = prepareAgentCommandExecutionIdentity({
    opts,
    prepared,
    ingress: { kind: "system", boundary: "restart-recovery-test", state: "present" },
    lifecycleGeneration,
  });
  try {
    await runEmbeddedAgentAttempt({
      prepared,
      preparedRunAdmission: admission,
      opts,
      sessionEntry: params.entry,
      lifecycleGeneration,
      onLifecycleGenerationChanged: () => {},
      suppressVisibleSessionEffects: false,
      preserveUserFacingSessionModelState: false,
      trackInternalModelRunTarget: () => {},
      embeddedSessionState: {
        sessionEntry: params.entry,
        requestedThinkLevel: "off",
        resolvedVerboseLevel: undefined,
        skillsSnapshot: { prompt: "", skills: [] },
        runContext: {},
      },
      modelSelection: {
        sessionEntry: params.entry,
        provider,
        model,
        requestedRouteResolution: "resolved",
        defaultProvider: provider,
        defaultModel: model,
        configuredDefaultAuthProfileId: undefined,
        providerForAuthProfileValidation: provider,
        hasExplicitRunOverride: false,
        storedProviderOverride: undefined,
        storedModelOverride: undefined,
        storedModelOverrideSource: undefined,
        hasStoredAutoFallbackProvenance: false,
        autoFallbackPrimaryProbe: undefined,
        sessionEntryForAttempt: params.entry,
        thinkingCatalog: [],
        immutableThinkLevel: "off",
        effectiveTurnThinkLevel: "off",
        sessionFile: path.join(path.dirname(params.storePath), `${params.entry.sessionId}.jsonl`),
      },
    });
  } finally {
    await admission.finish();
  }
}

export function registerAcceptedRecoveryStopCase(params: {
  getStateDir: () => string;
  makeMainSessionFixture: (overrides: SessionEntryFixture) => Promise<{
    sessionsDir: string;
    storePath: string;
    sessionKey: string;
    readEntry: () => ReturnType<typeof loadSessionEntry>;
  }>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  recoverRestartAbortedMainSessions: typeof recoverRestartAbortedMainSessions;
  retryRestartAbortedMainSessionRecovery: typeof retryRestartAbortedMainSessionRecovery;
  sendRecoveryNotice: GatewayRecoveryRuntime["sendRecoveryNotice"];
}): void {
  const {
    getStateDir,
    makeMainSessionFixture,
    writeTranscript,
    recoverRestartAbortedMainSessions,
    retryRestartAbortedMainSessionRecovery,
    sendRecoveryNotice,
  } = params;
  const discordDeliveryContext = { channel: "discord", to: "discord:dm:123" } as const;
  it("restores accepted recovery refused during stop and reports bounded exhaustion", async ({
    signal,
  }) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: getStateDir() }, async () => {
      const { sessionsDir, storePath, sessionKey, readEntry } = await makeMainSessionFixture({
        restartRecoveryDeliveryRunId: "recovery-main",
        restartRecoveryDeliverySourceRunId: "source-main",
        restartRecoveryDeliveryContext: discordDeliveryContext,
      });
      await writeTranscript(sessionsDir, "main-session", [
        { role: "user", content: "recover without losing the owner" },
      ]);
      // Runtime imports and I/O must settle before the unrelated start watchdog can expire.
      vi.useFakeTimers();
      const previousRegistry = captureActivePluginRegistrySnapshot();
      setActivePluginRegistry(createEmptyPluginRegistry());
      const scheduleSpy = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const transitionSpy = vi.spyOn(recoveryStore, "commitMainSessionRecovery");
      const queueSpy = vi.spyOn(commandQueue, "enqueueCommandInLane");
      const commandErrors: unknown[] = [];
      const emittedErrors: Record<string, unknown>[] = [];
      const persistedEntries: Array<ReturnType<typeof loadSessionEntry>> = [];
      const dispatchSettlements: Promise<void>[] = [];
      const dispatchRecoveryCommand = async (
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeoutMs: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[1],
        options: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ): Promise<never> => {
        const runId = request.idempotencyKey!;
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        await recoveryStore.commitMainSessionRecovery({
          command: {
            kind: "admit_recovery",
            lifecycleGeneration,
            now: Date.now(),
            runId,
            sessionId: "main-session",
          },
          requireWriteSuccess: true,
          target: { sessionKey, storePath },
        });
        options?.onAccepted?.({ runId, status: "accepted" });
        const admittedEntry = readEntry()!;
        const terminalEvents: Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"][] =
          [];
        const terminalObserved =
          createDeferred<Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"]>();
        const unsubscribe = onAgentEvent((event) => {
          if (
            event.runId === runId &&
            event.stream === "lifecycle" &&
            event.data.phase === "error"
          ) {
            terminalEvents.push(event);
            terminalObserved.resolve(event);
          }
        });
        // Observe the expected rejection immediately, then join its real lifecycle settlement.
        const commandSettlement = runRecoveryCommandDuringStop({
          entry: admittedEntry,
          runId,
          sessionKey,
          storePath,
          stateDir: getStateDir(),
          signal,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );
        let commandError: unknown;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              terminalObserved.promise,
              commandSettlement,
              "Expected command error lifecycle before shutdown command settled",
            ),
            signal,
          );
        } finally {
          commandError = await commandSettlement;
          unsubscribe();
        }
        commandErrors.push(commandError);
        for (const event of terminalEvents) {
          emittedErrors.push(event.data ?? {});
        }
        for (const event of terminalEvents) {
          await persistGatewaySessionLifecycleEvent({ sessionKey, agentId: "main", event });
        }
        persistedEntries.push(readEntry());
        throw commandError;
      };
      const dispatchAgent = vi.fn((...args: Parameters<typeof dispatchRecoveryCommand>) => {
        const dispatch = dispatchRecoveryCommand(...args);
        dispatchSettlements.push(
          dispatch.then(
            () => {},
            () => {},
          ),
        );
        return dispatch;
      });
      const gatewayRuntime = createMockGatewayRecoveryRuntime({
        dispatchAgent,
        sendRecoveryNotice,
        waitForAgent: vi.fn(async () => ({
          runId: "recovery-main",
          status: "timeout",
          timeoutPhase: "queue",
          providerStarted: false,
        })) as GatewayRecoveryRuntime["waitForAgent"],
      });
      try {
        await expect(
          retryRestartAbortedMainSessionRecovery({
            cfg: {},
            expectedRecoveryRunId: "recovery-main",
            expectedRecoverySourceRunId: "source-main",
            expectedSessionId: "main-session",
            sessionKey,
            storePath,
            gatewayRuntime,
          }),
        ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
        const restorationIndex = transitionSpy.mock.calls.findIndex(
          ([mutation]) => mutation.command.kind === "mark_admitted_recovery_interrupted",
        );
        expect(restorationIndex).toBeGreaterThanOrEqual(0);
        const restored = await transitionSpy.mock.results[restorationIndex]?.value;
        expect(restored?.transition).toEqual({ kind: "applied" });
        expect(queueSpy).toHaveBeenCalled();
        expect(commandErrors).toHaveLength(1);
        expect(commandErrors[0]).toBeInstanceOf(GatewayDrainingError);
        expect(emittedErrors).toEqual([
          expect.objectContaining({
            executionStarted: false,
            providerStarted: false,
          }),
        ]);
        expect(persistedEntries[0]?.status).toBeUndefined();
        expect(persistedEntries[0]).toMatchObject({
          mainRestartRecovery: { cycleId: "interrupted-cycle", chargedAttempts: 1 },
          restartRecoveryRuns: [
            { runId: "recovery-main", lifecycleGeneration: getAgentEventLifecycleGeneration() },
          ],
        });
        expect(readEntry()).toMatchObject({
          status: "interrupted",
          abortedLastRun: true,
          restartRecoveryDeliverySourceRunId: "source-main",
          mainRestartRecovery: { chargedAttempts: 1 },
          restartRecoveryRuns: [{ runId: "recovery-main" }],
        });
        expect(readEntry()?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(scheduleSpy).toHaveBeenCalledWith({
          agentId: "main",
          sessionId: "main-session",
          sessionKey,
          storePath,
        });

        for (const attempt of [2, 3]) {
          resetGatewayWorkAdmission();
          rotateAgentEventLifecycleGeneration();
          await expect(
            recoverRestartAbortedMainSessions({
              cfg: {},
              stateDir: getStateDir(),
              gatewayRuntime,
            }),
          ).resolves.toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(readEntry()).toMatchObject({
            status: "interrupted",
            mainRestartRecovery: { chargedAttempts: attempt },
          });
          expect(dispatchAgent).toHaveBeenCalledTimes(attempt);
        }
        expect(commandErrors).toHaveLength(3);
        for (const error of commandErrors) {
          expect(error).toBeInstanceOf(GatewayDrainingError);
        }
        expect(emittedErrors).toHaveLength(3);
        resetGatewayWorkAdmission();
        rotateAgentEventLifecycleGeneration();
        await expect(
          recoverRestartAbortedMainSessions({
            cfg: {},
            stateDir: getStateDir(),
            gatewayRuntime,
          }),
        ).resolves.toEqual({ started: 0, settled: 0, failed: 0, skipped: 1 });
        expect(dispatchAgent).toHaveBeenCalledTimes(3);
        expect(sendRecoveryNotice).toHaveBeenCalledWith(
          expect.objectContaining({
            text: expect.stringContaining("Resume in new session"),
          }),
        );
        expect(readEntry()).toMatchObject({
          status: "failed",
          mainRestartRecovery: { tombstone: expect.any(Object) },
        });
      } finally {
        await Promise.all(dispatchSettlements);
        scheduleSpy.mockRestore();
        transitionSpy.mockRestore();
        queueSpy.mockRestore();
        restoreActivePluginRegistrySnapshot(previousRegistry);
        vi.useRealTimers();
      }
    });
  });
}
