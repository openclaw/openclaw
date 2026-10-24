import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import type { RequesterOrigin } from "../requester-origin.js";

type RecoveryScope = { storePath: string; sessionKey: string };

export function observeRecoveryRoots(
  expectedOrigin: "main-session:startup-recovery" | "main-session:restart-recovery",
  expectedCount: number,
) {
  const requested = createDeferred();
  const completed = createDeferred();
  const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
  let count = 0;
  const spy = vi
    .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
    .mockImplementation(
      async <T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal): Promise<T> => {
        try {
          const result = admit(run, origin, signal);
          if (origin === expectedOrigin) {
            requested.resolve();
          }
          return await result;
        } finally {
          if (origin === expectedOrigin && ++count === expectedCount) {
            completed.resolve();
          }
        }
      },
    );
  return {
    requested: requested.promise,
    completed: completed.promise,
    restore: () => spy.mockRestore(),
  };
}

export function createRecoveryRuntimeFixture(params: {
  callGateway: (options: Parameters<typeof callGateway>[0]) => Promise<unknown>;
  getDispatchSettlement: () => Promise<void>;
  sendRecoveryNotice: GatewayRecoveryRuntime["sendRecoveryNotice"];
}) {
  const expectState = async (
    expectedGatewayCalls: number,
    scopes: RecoveryScope[],
    matches: (entry: NonNullable<ReturnType<typeof loadSessionEntry>>) => boolean,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const targets = scopes.map((scope) => {
      const entry = loadSessionEntry(scope);
      expect(entry, "recovery fixture session must exist").toBeDefined();
      return { scope, sessionId: entry?.sessionId };
    });
    const settled = createDeferred();
    const observe = () => {
      try {
        if (
          targets.every(({ scope, sessionId }) => {
            const entry = loadSessionEntry(scope);
            return entry !== undefined && entry.sessionId === sessionId && matches(entry);
          })
        ) {
          settled.resolve();
        }
      } catch (error) {
        // Session-change listeners isolate throws, so this wait must retain its read failure.
        settled.reject(error);
      }
    };
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        targets.some(({ scope }) => scope.sessionKey === change.sessionKey)
      ) {
        observe();
      }
    });
    const abort = () => settled.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    onTestFinished(unsubscribe);
    try {
      signal?.throwIfAborted();
      // Subscribe before reading so an already committed state also completes.
      observe();
      await settled.promise;
      signal?.throwIfAborted();
      expect(params.callGateway).toHaveBeenCalledTimes(expectedGatewayCalls);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    prepareRestartRecovery: () => undefined,
    async expectAdmission(
      expectedGatewayCalls: number,
      recovery: { stop: () => Promise<void> },
      ...scopes: RecoveryScope[]
    ) {
      try {
        await expectState(expectedGatewayCalls, scopes, (entry) => entry.abortedLastRun === false);
      } finally {
        await recovery.stop();
      }
    },
    async expectFailedRecovery(
      expectedGatewayCalls: number,
      recovery: { stop: () => Promise<void> },
      signal: AbortSignal,
      ...scopes: RecoveryScope[]
    ) {
      try {
        await expectState(
          expectedGatewayCalls,
          scopes,
          (entry) => entry.status === "failed" && entry.abortedLastRun === false,
          signal,
        );
      } finally {
        await recovery.stop();
      }
    },
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T>(
      request: Record<string, unknown>,
      timeoutMs?: number,
      options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
    ) => {
      const result = (await params.callGateway({
        method: "agent",
        params: request,
        timeoutMs,
      })) as T;
      const status = (result as { status?: unknown } | undefined)?.status;
      if (status === undefined) {
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true, startDeadlineAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.(result);
        options?.onExecutionStarted?.();
        await params.getDispatchSettlement();
      }
      return result;
    },
    waitForAgent: async <T>(request: Record<string, unknown>, timeoutMs?: number) => {
      return (await params.callGateway({ method: "agent.wait", params: request, timeoutMs })) as T;
    },
    sendRecoveryNotice: params.sendRecoveryNotice,
    resumeChatInput: vi.fn(),
  };
}

export async function runRecoveryCommandDuringStop(params: {
  entry: SessionEntry;
  requesterOrigin: RequesterOrigin;
  runId: string;
  sessionKey: string;
  storePath: string;
  stateDir: string;
  signal: AbortSignal;
}): Promise<void> {
  const [
    { getAcpSessionManager },
    { getAgentEventLifecycleGeneration },
    { markGatewayRestartDraining },
    { prepareAgentCommandExecutionIdentity },
    { runEmbeddedAgentAttempt },
  ] = await Promise.all([
    import("../../acp/control-plane/manager.js"),
    import("../../infra/agent-events.js"),
    import("../../process/gateway-work-admission.js"),
    import("../agent-command-execution-identity.js"),
    import("../command/run-embedded-attempt.js"),
  ]);
  const opts = {
    message: "Resume the interrupted task.",
    requesterOrigin: params.requesterOrigin,
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
