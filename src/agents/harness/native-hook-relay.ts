/** Native harness hook event relay and public Plugin SDK facade. */
import { randomUUID } from "node:crypto";
import {
  MAX_TIMER_TIMEOUT_MS,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";
import { formatPermissionApprovalDescription as formatPermissionApprovalDescriptionForTests } from "./native-hook-relay-approval-presentation.js";
import {
  clearNativeHookRelayBridgesForTests,
  NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR,
  readNativeHookRelayBridgeRecordIfExists,
  registerNativeHookRelayBridge,
  retainNativeHookRelayOperation,
  renewNativeHookRelayBridgeRecord,
  unregisterNativeHookRelayBridge,
  isRetryableNativeHookRelayBridgeLookupError,
} from "./native-hook-relay-bridge.js";
import {
  codexNativeHookRelayProviderAdapter,
  normalizeNativeHookInvocation,
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import {
  processNativeHookRelayInvocation,
  snapshotNativeHookRelayExecutionAdmission,
} from "./native-hook-relay-events.js";
import {
  isNativeHookRelayReadinessProbe,
  projectNativeHookRelayPreToolUseFailure,
} from "./native-hook-relay-invocation-guards.js";
import {
  buildNativeHookRelayTurnClaimKey,
  canAcceptNativeHookRelayGenerationMismatch,
  claimAndVerifyRelayTurn,
  claimNativeHookRelayTurn,
  ensureNativeHookRelayTurnClaims,
  isLiveNativeHookRelayRegistration,
  latestNativeHookRelayRegistration,
  normalizeNativeHookRelayKey,
  resolveNativeHookRelayInvocationTarget,
  retireNativeHookRelayTurnClaims,
} from "./native-hook-relay-ownership.js";
import {
  clearNativeHookRelayPermissionsForTests,
  permissionRequestContentFingerprintForTests,
  permissionRequestToolInputKeyFingerprintForTests,
  pruneNativeHookRelayPermissionAllowAlways,
  detachNativeHookRelayApprovalState,
  setNativeHookRelayDeferredToolApprovalRequesterForTests,
  setNativeHookRelayPermissionApprovalRequesterForTests,
} from "./native-hook-relay-permissions.js";
import { buildNativeHookRelayCommandPlan } from "./native-hook-relay-plan.js";
import { verifyNativeHookRelayPreToolUseReadiness } from "./native-hook-relay-readiness.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayRegistrationsById,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  ActiveNativeHookRelayRegistrationHandle,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayOwnerOptions,
  NativeHookRelayProcessResponse,
  OwnedNativeHookRelayParams,
  OwnedNativeHookRelayRegistrationHandle,
  RegisterNativeHookRelayParams,
  RelayLifetime,
} from "./native-hook-relay-types.js";
import { NATIVE_HOOK_RELAY_EVENTS } from "./native-hook-relay-types.js";
import {
  isJsonValue,
  normalizePositiveInteger,
  readNativeHookRelayEvent,
  readNativeHookRelayProvider,
  readNonEmptyString,
  snapshotNativeHookRelayPayload,
} from "./native-hook-relay-utils.js";
import {
  assertNativeHookRelayForegroundCurrent,
  drainNativeHookRelayWork,
  prepareNativeHookRelayMcpPolicy,
  resolveNativeHookRelayInvocationBinding,
} from "./native-hook-relay-work.js";
export { buildNativeHookRelayCommand } from "./native-hook-relay-command.js";
export { resolveNativeHookRelayDeferredToolApproval } from "./native-hook-relay-permissions.js";
export type {
  NativeHookRelayEvent,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
  NativeHookRelayRegistrationHandle,
} from "./native-hook-relay-types.js";

const DEFAULT_RELAY_TTL_MS = 30 * 60 * 1000;
const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { relays, relayBridges, invocations } = nativeHookRelayState;
const relayRegistrationsById = nativeHookRelayRegistrationsById;
const RELAY_LIFETIME = "__openclawNativeHookRelayLifetimeV1";
const MAX_NATIVE_HOOK_RELAY_REGISTRATIONS_PER_ID = 8;
let readinessGatewayInvokerForTests:
  | ((params: InvokeNativeHookRelayParams) => Promise<NativeHookRelayProcessResponse>)
  | undefined;

type RelayLifetimeRegistration = ActiveNativeHookRelayRegistration & {
  [RELAY_LIFETIME]?: RelayLifetime;
};

function readRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
): RelayLifetime | undefined {
  // SAFETY: this private expando is installed only by setRelayLifetime below.
  return (registration as RelayLifetimeRegistration)[RELAY_LIFETIME];
}

function setRelayLifetime(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime,
): void {
  Object.defineProperty(registration, RELAY_LIFETIME, {
    configurable: true,
    value: lifetime,
  });
}

function scheduleNativeHookRelayExpiry(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  if (lifetime.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  const rearm = () => {
    if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
      return;
    }
    const remainingMs = registration.expiresAtMs - Date.now();
    if (remainingMs < 0) {
      unregisterNativeHookRelay(relayId, registration);
      return;
    }
    lifetime.expiryTimer = setTimeout(rearm, Math.min(remainingMs + 1, MAX_TIMER_TIMEOUT_MS));
    lifetime.expiryTimer.unref();
  };
  rearm();
}

function resolveNativeHookRelayExpiresAtMs(ttlMs: number | undefined): number | undefined {
  return resolveExpiresAtMsFromDurationMs(normalizePositiveInteger(ttlMs, DEFAULT_RELAY_TTL_MS));
}

export function registerNativeHookRelay(
  params: RegisterNativeHookRelayParams,
): ActiveNativeHookRelayRegistrationHandle {
  return registerNativeHookRelayInternal(params);
}

/** Private-local bundled runtime entrypoint; not exported through the public SDK. */
export function registerOwnedNativeHookRelay(
  params: OwnedNativeHookRelayParams,
): OwnedNativeHookRelayRegistrationHandle {
  const { retention, approvalHost, executionAdmission, ...registrationParams } = params;
  return registerNativeHookRelayInternal(registrationParams, {
    retention,
    approvalHost,
    executionAdmission,
  });
}

function registerNativeHookRelayInternal(
  params: RegisterNativeHookRelayParams,
  owner?: NativeHookRelayOwnerOptions,
): OwnedNativeHookRelayRegistrationHandle {
  const { retention, approvalHost } = owner ?? {};
  const executionAdmission = snapshotNativeHookRelayExecutionAdmission(owner?.executionAdmission);
  pruneExpiredNativeHookRelays();
  pruneNativeHookRelayPermissionAllowAlways();
  const relayId = normalizeNativeHookRelayKey(params.relayId, "id") ?? randomUUID();
  const generation = normalizeNativeHookRelayKey(params.generation, "generation") ?? randomUUID();
  const readinessNonce = randomUUID();
  const generationMismatchGraceMs = normalizePositiveInteger(params.generationMismatchGraceMs, 0);
  const now = Date.now();
  const expiresAtMs = resolveNativeHookRelayExpiresAtMs(params.ttlMs);
  if (expiresAtMs === undefined) {
    throw new Error("Native hook relay expiry is outside the supported Date range");
  }
  const allowedEvents = params.allowedEvents?.length
    ? [...new Set(params.allowedEvents)]
    : NATIVE_HOOK_RELAY_EVENTS;
  const stateDbPath = resolveOpenClawStateSqlitePath();
  let partialRegistration: ActiveNativeHookRelayRegistration | undefined;
  const policy = prepareNativeHookRelayMcpPolicy(
    params,
    stateDbPath,
    () =>
      partialRegistration !== undefined &&
      isLiveNativeHookRelayRegistration(relayId, partialRegistration),
  );
  try {
    let deferMcpToolApprovals: boolean | undefined;
    const registration = {
      relayId,
      provider: params.provider,
      generation,
      readinessNonce,
      ...(generationMismatchGraceMs > 0
        ? { generationMismatchGraceExpiresAtMs: now + generationMismatchGraceMs }
        : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.config ? { config: params.config } : {}),
      get deferMcpToolApprovals() {
        return deferMcpToolApprovals;
      },
      runId: params.runId,
      ...(params.channelId ? { channelId: params.channelId } : {}),
      ...(params.requester ? { requester: params.requester } : {}),
      ...(params.approvalContext ? { approvalContext: params.approvalContext } : {}),
      allowedEvents,
      preToolUseLoopDetection: params.preToolUseLoopDetection !== false,
      expiresAtMs,
      preToolUseFailureProjections: new Map(),
      claimedTurnIds: new Set(),
      ...(params.signal ? { signal: params.signal } : {}),
      ...(params.runBeforeToolCall ? { runBeforeToolCall: params.runBeforeToolCall } : {}),
      ...(approvalHost ? { approvalHost } : {}),
      ...(params.assertActive ? { assertActive: params.assertActive } : {}),
      ...(params.onPreToolUseFailure ? { onPreToolUseFailure: params.onPreToolUseFailure } : {}),
      // SAFETY: the literal supplies the complete mutable internal registration contract.
    } as ActiveNativeHookRelayRegistration;
    partialRegistration = registration;
    let registrations = relayRegistrationsById.get(relayId);
    if (!registrations) {
      registrations = new Set();
      relayRegistrationsById.set(relayId, registrations);
    }
    // A duplicate module loaded before the multi-owner state upgrade may have
    // published only the legacy latest-owner entry. Preserve it as a sibling
    // rather than silently replacing its live authority.
    const legacyRegistration = relays.get(relayId);
    if (legacyRegistration && !registrations.has(legacyRegistration)) {
      ensureNativeHookRelayTurnClaims(legacyRegistration);
      registrations.add(legacyRegistration);
    }
    if (registrations.size >= MAX_NATIVE_HOOK_RELAY_REGISTRATIONS_PER_ID) {
      throw new Error("native hook relay registration capacity exceeded");
    }
    const retained =
      params.runBeforeToolCall && retention
        ? retainBeforeToolCallForNativeHookRelay(params.runBeforeToolCall)
        : undefined;
    registrations.add(registration);
    relays.set(relayId, registration);
    const policyReady = policy.then((prepared) => {
      deferMcpToolApprovals = prepared;
    });
    retainNativeHookRelayOperation(relayId, policyReady);
    setRelayLifetime(registration, {
      foregroundOpen: true,
      foregroundToken: Symbol("native-hook-relay-foreground"),
      policyReady,
      ...(retained ? { retained } : {}),
      ...(retention ? { retention } : {}),
      ...(executionAdmission ? { executionAdmission } : {}),
    });
    if (params.signal) {
      const abort = () => unregisterNativeHookRelay(relayId, registration);
      params.signal.addEventListener("abort", abort, { once: true });
      readRelayLifetime(registration)!.removeAbortListener = () =>
        params.signal?.removeEventListener("abort", abort);
      if (params.signal.aborted) {
        unregisterNativeHookRelay(relayId, registration);
        throw new Error("native hook relay registration aborted");
      }
    }
    const bridge = registerNativeHookRelayBridge(registration, stateDbPath, invokeNativeHookRelay);
    scheduleNativeHookRelayExpiry(relayId, registration);
    let pendingRenewal = Promise.resolve();
    const ready = Promise.all([bridge.ready, policyReady]).then(() => undefined);
    // Component owners report failure even when a public synchronous caller never awaits readiness.
    void ready.catch(() => undefined);
    const handle: OwnedNativeHookRelayRegistrationHandle = {
      ...registration,
      ...buildNativeHookRelayCommandPlan({
        ...params,
        relayId,
        generation,
        executionAdmissionToolNames: executionAdmission?.toolNames,
      }),
      get deferMcpToolApprovals() {
        return deferMcpToolApprovals;
      },
      ready,
      prepareInvocation: async () => {
        const lifetime = readRelayLifetime(registration);
        if (!lifetime) {
          throw new Error("native hook relay registration is inactive");
        }
        const foregroundToken = lifetime.foregroundToken;
        assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
        await policyReady;
        // Only direct transport failure may use the existing Gateway route.
        await bridge.ready.catch(() => undefined);
        assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
      },
      drain: () =>
        drainNativeHookRelayWork({ policyReady, bridge, readRenewal: () => pendingRenewal }),
      renew: (ttlMs) => {
        if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
          return;
        }
        const renewedExpiresAtMs = resolveNativeHookRelayExpiresAtMs(ttlMs);
        if (renewedExpiresAtMs === undefined) {
          return;
        }
        pendingRenewal = pendingRenewal.then(async () => {
          if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
            return;
          }
          if (bridge.server.listening) {
            try {
              const renewal = await renewNativeHookRelayBridgeRecord(
                registration,
                bridge,
                renewedExpiresAtMs,
              );
              if (renewal === "unavailable") {
                return;
              }
              if (renewal === "ownership-changed") {
                log.debug("native hook relay bridge record ownership changed", { relayId });
                unregisterNativeHookRelay(relayId, registration);
                return;
              }
            } catch (error) {
              log.debug("failed to renew native hook relay bridge record", { error, relayId });
              return;
            }
          }
          if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
            return;
          }
          registration.expiresAtMs = renewedExpiresAtMs;
          handle.expiresAtMs = renewedExpiresAtMs;
          scheduleNativeHookRelayExpiry(relayId, registration);
        });
      },
      claimTurn: (turnId, threadId) =>
        claimNativeHookRelayTurn({
          relayId,
          registration,
          turnIdInput: turnId,
          threadIdInput: threadId,
          onDuplicate: (sibling) =>
            log.warn("native hook relay refused duplicate turn claim", {
              relayId,
              runId: registration.runId,
              claimantRunId: sibling.runId,
            }),
        }),
      claimAndVerifyTurn: (turnId, assertCurrent, bindProcessAuthority, threadId) =>
        claimAndVerifyRelayTurn(handle, turnId, assertCurrent, bindProcessAuthority, threadId),
      verifyPreToolUse: async (turnIdInput, threadIdInput) => {
        if (!allowedEvents.includes("pre_tool_use")) {
          return;
        }
        const turnId = turnIdInput.trim();
        const claimKey = buildNativeHookRelayTurnClaimKey(turnId, threadIdInput);
        if (!turnId || !registration.claimedTurnIds.has(claimKey)) {
          throw new Error("native hook relay readiness failed (turn ownership): unclaimed turn");
        }
        await verifyNativeHookRelayPreToolUseReadiness({
          provider: registration.provider,
          relayId,
          generation,
          readinessNonce,
          sessionId: registration.sessionId,
          nativeThreadId: threadIdInput,
          turnId,
          recover: async () => {
            handle.renew();
            await handle.drain();
          },
          invokeGateway: readinessGatewayInvokerForTests,
        });
      },
      unregister: () => deactivateNativeHookRelayForeground(relayId, registration),
    };
    return handle;
  } catch (error) {
    if (partialRegistration) {
      unregisterNativeHookRelay(relayId, partialRegistration);
    }
    throw error;
  }
}

function unregisterNativeHookRelay(
  relayId: string,
  expectedRegistration?: ActiveNativeHookRelayRegistration,
  options?: { deferListenerCloseMs?: number; deferOnUnregister?: boolean },
): (() => void) | undefined {
  const registration = expectedRegistration ?? relays.get(relayId);
  if (!registration) {
    return undefined;
  }
  const registrations = relayRegistrationsById.get(relayId);
  if (registrations?.has(registration)) {
    registrations.delete(registration);
    if (registrations.size === 0) {
      relayRegistrationsById.delete(relayId);
    }
  } else if (relays.get(relayId) !== registration) {
    return undefined;
  }
  const lifetime = readRelayLifetime(registration);
  const bridge = relayBridges.get(relayId);
  // Detach first: owner cleanup may register a same-id successor, which must
  // never be removed by this registration's later resource cleanup.
  if (relays.get(relayId) === registration) {
    const successor = latestNativeHookRelayRegistration(registrations);
    if (successor) {
      relays.set(relayId, successor);
    } else {
      relays.delete(relayId);
    }
  }
  if (lifetime?.expiryTimer) {
    clearTimeout(lifetime.expiryTimer);
  }
  lifetime?.removeAbortListener?.();
  lifetime?.retained?.release();
  // SAFETY: this deletes the same private expando installed by setRelayLifetime.
  delete (registration as RelayLifetimeRegistration)[RELAY_LIFETIME];
  retireNativeHookRelayTurnClaims(relayId, registration);
  const cancelRegistrationApprovals = detachNativeHookRelayApprovalState(
    relayId,
    registration.runId,
  );
  cancelRegistrationApprovals();
  if (!relayRegistrationsById.get(relayId)?.size && !relays.has(relayId)) {
    void unregisterNativeHookRelayBridge(relayId, {
      ...options,
      ...(bridge ? { expectedBridge: bridge } : {}),
    });
    removeNativeHookRelayInvocations(relayId);
    const cancelApprovals = detachNativeHookRelayApprovalState(relayId);
    cancelApprovals();
  }
  const deliverOnUnregister = () => {
    try {
      lifetime?.retention?.onDispose();
    } catch (error) {
      try {
        log.warn("native hook relay unregister callback failed", { error, relayId });
      } catch {
        // Teardown has already detached every identity-bound resource. Logging
        // must not turn an observer callback failure into a cleanup failure.
      }
    }
  };
  if (options?.deferOnUnregister) {
    return deliverOnUnregister;
  }
  deliverOnUnregister();
  return undefined;
}

function deactivateNativeHookRelayForeground(
  relayId: string,
  registration: ActiveNativeHookRelayRegistration,
): void {
  if (!isLiveNativeHookRelayRegistration(relayId, registration)) {
    return;
  }
  const lifetime = readRelayLifetime(registration);
  if (!lifetime) {
    return;
  }
  lifetime.foregroundOpen = false;
  let shouldRetain = false;
  if (lifetime.retained && lifetime.retention) {
    try {
      shouldRetain = lifetime.retention.shouldRetainAfterForegroundClose();
    } catch (error) {
      try {
        log.warn("native hook relay retention predicate failed", { error, relayId });
      } catch {
        // A logging failure cannot make a throwing retention predicate retain authority.
      }
    }
  }
  if (shouldRetain) {
    // Retention covers child PreToolUse only; foreground approval authority ends now.
    const cancelApprovals = detachNativeHookRelayApprovalState(relayId, registration.runId);
    cancelApprovals();
    return;
  }
  unregisterNativeHookRelay(relayId, registration);
}

export async function invokeNativeHookRelay(
  params: InvokeNativeHookRelayParams,
  invocationSignal?: AbortSignal,
): Promise<NativeHookRelayProcessResponse> {
  const provider = readNativeHookRelayProvider(params.provider);
  const relayId = readNonEmptyString(params.relayId, "relayId");
  const event = readNativeHookRelayEvent(params.event);
  const registration = resolveNativeHookRelayInvocationTarget({
    relayId,
    requestedGeneration: typeof params.generation === "string" ? params.generation : undefined,
    rawPayload: params.rawPayload,
    readLifetime: readRelayLifetime,
  });
  if (!registration) {
    pruneExpiredNativeHookRelays();
    throw new Error("native hook relay not found");
  }
  const signal =
    invocationSignal && registration.signal
      ? AbortSignal.any([invocationSignal, registration.signal])
      : (invocationSignal ?? registration.signal);
  signal?.throwIfAborted();
  if (Date.now() > registration.expiresAtMs) {
    unregisterNativeHookRelay(relayId, registration);
    throw new Error("native hook relay expired");
  }
  if (registration.provider !== provider) {
    throw new Error("native hook relay provider mismatch");
  }
  if (params.requireGeneration) {
    const generation = readNonEmptyString(params.generation, "generation");
    if (generation !== registration.generation) {
      if (!canAcceptNativeHookRelayGenerationMismatch(registration, generation)) {
        throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
      }
      log.debug("native hook relay accepted bootstrap generation mismatch", {
        relayId,
        event,
        runId: registration.runId,
      });
    }
  }
  if (!registration.allowedEvents.includes(event)) {
    throw new Error("native hook relay event not allowed");
  }
  if (!isJsonValue(params.rawPayload)) {
    throw new Error("native hook relay payload must be JSON-compatible");
  }
  const isReadinessProbe = isNativeHookRelayReadinessProbe({
    params,
    registration,
    event,
  });

  const normalized = normalizeNativeHookInvocation({
    registration,
    event,
    rawPayload: params.rawPayload,
  });
  const { registration: effectiveRegistration, assertExecutionAdmissionCurrent } =
    await resolveNativeHookRelayInvocationBinding(
      registration,
      readRelayLifetime(registration),
      event,
      params.rawPayload,
      signal,
      isReadinessProbe,
    );
  if (event === "pre_tool_use" || event === "permission_request") {
    effectiveRegistration.assertActive?.();
  }
  recordNativeHookRelayInvocation(normalized);
  const startedAt = Date.now();
  const response = await racePromiseWithAbortSignal(
    processNativeHookRelayInvocation({
      registration: effectiveRegistration,
      invocation: normalized,
      adapter: codexNativeHookRelayProviderAdapter,
      executionAdmission: isReadinessProbe
        ? undefined
        : readRelayLifetime(registration)?.executionAdmission,
      assertExecutionAdmissionCurrent,
    }),
    signal,
  );
  // Policy and approval callbacks may yield while their admitted run closes.
  // Never let a late allow cross back into the native runtime.
  if (event === "pre_tool_use" || event === "permission_request") {
    effectiveRegistration.assertActive?.();
  }
  if (
    normalized.toolUseId &&
    response.failureDisposition &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report"
  ) {
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: normalizeNativeHookToolName(normalized.toolName),
      toolCallId: normalized.toolUseId,
      disposition: response.failureDisposition,
      durationMs: Date.now() - startedAt,
    });
  }
  return response;
}

export function hasNativeHookRelayInvocation(params: {
  relayId: string;
  event: NativeHookRelayEvent;
  toolUseId?: string;
}): boolean {
  const toolUseId = params.toolUseId?.trim();
  if (!toolUseId) {
    return false;
  }
  return invocations.some(
    (invocation) =>
      invocation.relayId === params.relayId &&
      invocation.event === params.event &&
      invocation.toolUseId === toolUseId,
  );
}

function recordNativeHookRelayInvocation(invocation: NativeHookRelayInvocation): void {
  invocations.push({
    ...invocation,
    rawPayload: snapshotNativeHookRelayPayload(invocation.rawPayload),
  });
  if (invocations.length > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    invocations.splice(0, invocations.length - MAX_NATIVE_HOOK_RELAY_INVOCATIONS);
  }
}

function removeNativeHookRelayInvocations(relayId: string): void {
  for (let index = invocations.length - 1; index >= 0; index -= 1) {
    if (invocations[index]?.relayId === relayId) {
      invocations.splice(index, 1);
    }
  }
}

function pruneExpiredNativeHookRelays(now = Date.now()): void {
  for (const [relayId, registrations] of relayRegistrationsById) {
    for (const registration of registrations) {
      if (now > registration.expiresAtMs) {
        unregisterNativeHookRelay(relayId, registration);
      }
    }
  }
}

export const testing = {
  async clearNativeHookRelaysForTests(): Promise<void> {
    for (const [relayId, registrations] of relayRegistrationsById) {
      for (const registration of registrations) {
        unregisterNativeHookRelay(relayId, registration);
      }
    }
    await clearNativeHookRelayBridgesForTests();
    invocations.length = 0;
    readinessGatewayInvokerForTests = undefined;
    clearNativeHookRelayPermissionsForTests();
  },
  setNativeHookRelayReadinessGatewayInvokerForTests(
    invoke:
      | ((params: InvokeNativeHookRelayParams) => Promise<NativeHookRelayProcessResponse>)
      | undefined,
  ): void {
    readinessGatewayInvokerForTests = invoke;
  },
  getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
    return [...invocations];
  },
  getNativeHookRelayRegistrationForTests(
    relayId: string,
  ): ActiveNativeHookRelayRegistration | undefined {
    return relays.get(relayId);
  },
  getNativeHookRelayBridgeDirForTests(): string {
    throw new Error("native hook relay bridge files were retired");
  },
  getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
    void relayId;
    throw new Error("native hook relay bridge files were retired");
  },
  async getNativeHookRelayBridgeRecordForTests(
    relayId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const record = await readNativeHookRelayBridgeRecordIfExists(relayId);
    return record ? { ...record } : undefined;
  },
  isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
    return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
  },
  formatPermissionApprovalDescriptionForTests,
  permissionRequestContentFingerprintForTests,
  permissionRequestToolInputKeyFingerprintForTests,
  setNativeHookRelayPermissionApprovalRequesterForTests,
  setNativeHookRelayDeferredToolApprovalRequesterForTests,
} as const;
