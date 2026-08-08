/**
 * Bridges Codex native hook callbacks into OpenClaw's native hook relay so
 * app-server tool events can still run OpenClaw policy and diagnostics.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  embeddedAgentLog,
  registerNativeHookRelay,
  type BeforeToolCallFailureDisposition,
  type EmbeddedRunAttemptParams,
  type NativeHookRelayEvent,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { emitTrustedDiagnosticEvent } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  addTimerTimeoutGraceMs,
  finiteSecondsToTimerSafeMilliseconds,
} from "openclaw/plugin-sdk/number-runtime";
import type { PluginHookToolContext } from "openclaw/plugin-sdk/types";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { resolveCodexToolAbortTerminalReason } from "./dynamic-tool-execution.js";
import {
  CODEX_NATIVE_HOOK_RELAY_EVENTS,
  normalizeHookTimeoutSec,
} from "./native-hook-relay-config.js";
import {
  codexNativeHookRelayOwners as codexNativeHookRelayOwnerRegistry,
  nativeHookRelayUnregisterQueue,
} from "./native-hook-relay-state.js";

const CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS =
  CODEX_NATIVE_HOOK_RELAY_EVENTS.filter((event) => event !== "permission_request");
const CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS = 30 * 60_000;
/** Extra relay lifetime after the expected turn budget, preventing late hook drops. */
export const CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS = 5 * 60_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS = 10_000;
const CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS = 5_000;

export type CodexNativePreToolUseFailure = {
  toolName: string;
  toolCallId: string;
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
  durationMs: number;
};

export type CodexNativeHookRelayLease = Omit<
  NativeHookRelayRegistrationHandle,
  "unregister" | "rebindAttempt"
> & {
  acquireChild: (childThreadId: string) => (() => void) | undefined;
  releaseParent: (options?: { delay?: boolean }) => void;
};

type CodexNativeHookRelayParams = {
  options:
    | {
        enabled?: boolean;
        ttlMs?: number;
        gatewayTimeoutMs?: number;
        hookTimeoutSec?: number;
      }
    | undefined;
  generation?: string;
  events: readonly NativeHookRelayEvent[];
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  config: EmbeddedRunAttemptParams["config"];
  runId: string;
  channelId?: string;
  requester?: NonNullable<PluginHookToolContext["requester"]>;
  approvalContext?: Parameters<typeof registerNativeHookRelay>[0]["approvalContext"];
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
  loopDetectionPreToolUseRelay: boolean;
  signal: AbortSignal;
  onPreToolUseFailure: (failure: CodexNativePreToolUseFailure) => void | Promise<void>;
};

/** Defers relay unregister so late native hook subprocesses can still resolve. */
function scheduleCodexNativeHookRelayUnregister(params: {
  relay: Pick<NativeHookRelayRegistrationHandle, "unregister">;
  hookTimeoutSec?: number;
  beforeUnregister?: () => void;
}): () => void {
  let pending: { timeout: ReturnType<typeof setTimeout>; unregister: () => void } | undefined;
  const unregister = () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (!nativeHookRelayUnregisterQueue.delete(current)) {
      return;
    }
    params.beforeUnregister?.();
    params.relay.unregister();
  };
  const timeout = setTimeout(
    unregister,
    resolveCodexNativeHookRelayUnregisterGraceMs(params.hookTimeoutSec),
  );
  pending = { timeout, unregister };
  nativeHookRelayUnregisterQueue.add(pending);
  timeout.unref();
  return () => {
    if (!pending) {
      return;
    }
    const current = pending;
    pending = undefined;
    if (nativeHookRelayUnregisterQueue.delete(current)) {
      clearTimeout(current.timeout);
    }
  };
}

/** Computes the delayed unregister window from Codex's hook timeout. */
function resolveCodexNativeHookRelayUnregisterGraceMs(hookTimeoutSec: number | undefined): number {
  const hookTimeoutMs =
    finiteSecondsToTimerSafeMilliseconds(normalizeHookTimeoutSec(hookTimeoutSec)) ?? 0;
  return Math.max(
    CODEX_NATIVE_HOOK_RELAY_UNREGISTER_GRACE_MS,
    addTimerTimeoutGraceMs(hookTimeoutMs, CODEX_NATIVE_HOOK_RELAY_UNREGISTER_EXTRA_GRACE_MS) ?? 0,
  );
}

/** Records a native pre-tool failure that Codex does not project as a tool item. */
export function emitCodexNativePreToolUseFailureDiagnostic(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal?: AbortSignal;
  failure: CodexNativePreToolUseFailure;
  terminalReason?: CodexNativePreToolUseFailure["disposition"];
  sourceTimestampMs?: number;
}): void {
  emitTrustedDiagnosticEvent({
    type: "tool.execution.error",
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionId: params.sessionId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    runId: params.runId,
    toolName: params.failure.toolName,
    toolCallId: params.failure.toolCallId,
    durationMs: params.failure.durationMs,
    errorCategory: "before_tool_call",
    terminalReason:
      params.terminalReason ??
      (params.signal?.aborted
        ? resolveCodexToolAbortTerminalReason(params.signal)
        : params.failure.disposition),
    ...(params.sourceTimestampMs !== undefined
      ? { sourceTimestampMs: params.sourceTimestampMs }
      : {}),
  });
}

export function createCodexNativeHookRelay(
  params: CodexNativeHookRelayParams,
): CodexNativeHookRelayLease | undefined {
  if (params.options?.enabled === false) {
    return undefined;
  }
  const generation = params.generation?.trim() || randomUUID();
  const attempt: CodexNativeHookRelayAttempt = { ...params, generation };
  const relayId = buildCodexNativeHookRelayId({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    generation,
  });
  const liveRoute = codexNativeHookRelayOwners.get(relayId);
  return liveRoute
    ? liveRoute.adoptAttempt(attempt)
    : new CodexNativeHookRelayRoute(attempt, relayId).attemptLease;
}

type CodexNativeHookRelayRenewal = ReturnType<NativeHookRelayRegistrationHandle["renew"]>;

type CodexNativeHookRelayAttempt = CodexNativeHookRelayParams & { generation: string };

type CodexNativeHookRelayAttemptClaim = {
  readonly attempt: CodexNativeHookRelayAttempt;
  detachAbort: () => void;
};

type CodexNativeHookRelayBinding = Parameters<
  NonNullable<NativeHookRelayRegistrationHandle["rebindAttempt"]>
>[0];

function codexNativeHookRelayAttemptBinding(attempt: CodexNativeHookRelayAttempt) {
  return {
    runId: attempt.runId,
    ...(attempt.config ? { config: attempt.config } : {}),
    ...(attempt.channelId ? { channelId: attempt.channelId } : {}),
    ...(attempt.requester ? { requester: attempt.requester } : {}),
    ...(attempt.approvalContext ? { approvalContext: attempt.approvalContext } : {}),
    preToolUseLoopDetection: attempt.loopDetectionPreToolUseRelay,
  };
}

function resolveCodexNativeHookRelayAttemptTtlMs(attempt: CodexNativeHookRelayAttempt): number {
  return resolveCodexNativeHookRelayTtlMs({
    explicitTtlMs: attempt.options?.ttlMs,
    attemptTimeoutMs: attempt.attemptTimeoutMs,
    startupTimeoutMs: attempt.startupTimeoutMs,
    turnStartTimeoutMs: attempt.turnStartTimeoutMs,
  });
}

class CodexNativeHookRelayRoute {
  readonly attemptLease: CodexNativeHookRelayLease | undefined;

  private readonly childThreadIds = new Set<string>();
  private readonly relayId: string;
  private readonly lifetimeAbortController = new AbortController();
  private attempt: CodexNativeHookRelayAttempt;
  private relay: NativeHookRelayRegistrationHandle;
  private attemptClaim: CodexNativeHookRelayAttemptClaim | undefined;
  private ttlMs: number;
  private hookTimeoutSec: number | undefined;
  private renewalTimer: ReturnType<typeof setTimeout> | undefined;
  private cancelPendingUnregister: (() => void) | undefined;
  private released = false;

  constructor(attempt: CodexNativeHookRelayAttempt, relayId: string) {
    this.relayId = relayId;
    this.attempt = attempt;
    this.ttlMs = resolveCodexNativeHookRelayAttemptTtlMs(attempt);
    this.hookTimeoutSec = attempt.options?.hookTimeoutSec;
    this.relay = this.registerRoute(this.retiredBinding(attempt));
    codexNativeHookRelayOwners.set(relayId, this);
    this.attemptLease = this.bindAttempt(attempt);
    embeddedAgentLog.debug("Codex native hook relay route registered", {
      relayId,
      generation: attempt.generation,
      runId: attempt.runId,
    });
  }

  adoptAttempt(attempt: CodexNativeHookRelayAttempt): CodexNativeHookRelayLease | undefined {
    if (this.released) {
      return undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.retireAttemptClaim();
    const lease = this.bindAttempt(attempt);
    if (!lease) {
      return undefined;
    }
    embeddedAgentLog.debug("Codex native hook relay attempt adopted", {
      relayId: this.relayId,
      runId: attempt.runId,
      childCount: this.childThreadIds.size,
    });
    this.renew(this.ttlMs);
    return lease;
  }

  private registerRoute(binding: CodexNativeHookRelayBinding): NativeHookRelayRegistrationHandle {
    const attempt = this.attempt;
    return registerNativeHookRelay({
      provider: "codex",
      relayId: this.relayId,
      generation: attempt.generation,
      ...(attempt.agentId ? { agentId: attempt.agentId } : {}),
      sessionId: attempt.sessionId,
      ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
      ...binding,
      allowedEvents: CODEX_NATIVE_HOOK_RELAY_EVENTS,
      ttlMs: this.ttlMs,
      command: {
        // Hook relay subprocesses are observational for most tool events; keep
        // them lower priority so they do not compete with the active reply turn.
        nice: 10,
        timeoutMs: attempt.options?.gatewayTimeoutMs,
      },
    });
  }

  private reregisterRoute(binding: CodexNativeHookRelayBinding): void {
    embeddedAgentLog.debug("Codex native hook relay registration re-registered", {
      relayId: this.relayId,
      runId: this.attempt.runId,
    });
    this.relay = this.registerRoute(binding);
  }

  private bindAttempt(attempt: CodexNativeHookRelayAttempt): CodexNativeHookRelayLease | undefined {
    this.attempt = attempt;
    this.ttlMs = resolveCodexNativeHookRelayAttemptTtlMs(attempt);
    this.hookTimeoutSec = attempt.options?.hookTimeoutSec;
    const claim: CodexNativeHookRelayAttemptClaim = { attempt, detachAbort: () => undefined };
    this.attemptClaim = claim;
    const binding = this.claimBinding(claim);
    if (!this.relay.rebindAttempt?.(binding)) {
      this.reregisterRoute(binding);
    }
    this.attachAttemptAbort(claim);
    if (this.released) {
      return undefined;
    }
    const readExpiresAtMs = () => this.relay.expiresAtMs;
    const { unregister: _unregister, rebindAttempt: _rebindAttempt, ...fields } = this.relay;
    return {
      ...fields,
      allowedEvents: attempt.events,
      get expiresAtMs() {
        return readExpiresAtMs();
      },
      renew: (ttlMs?: number) => this.renew(ttlMs),
      acquireChild: (childThreadId: string) => this.acquireChild(childThreadId),
      releaseParent: (options?: { delay?: boolean }) => this.releaseAttempt(claim, options),
    };
  }

  private claimBinding(claim: CodexNativeHookRelayAttemptClaim): CodexNativeHookRelayBinding {
    return {
      ...codexNativeHookRelayAttemptBinding(claim.attempt),
      signal: AbortSignal.any([this.lifetimeAbortController.signal, claim.attempt.signal]),
      onPreToolUseFailure: claim.attempt.onPreToolUseFailure,
    };
  }

  private retiredBinding(attempt: CodexNativeHookRelayAttempt): CodexNativeHookRelayBinding {
    return {
      ...codexNativeHookRelayAttemptBinding(attempt),
      signal: this.lifetimeAbortController.signal,
      onPreToolUseFailure: this.unclaimedPreToolUseFailureSink(attempt.runId),
    };
  }

  private unclaimedPreToolUseFailureSink(runId: string) {
    return (failure: CodexNativePreToolUseFailure) =>
      emitCodexNativePreToolUseFailureDiagnostic({
        agentId: this.relay.agentId,
        sessionId: this.relay.sessionId,
        sessionKey: this.relay.sessionKey,
        runId,
        failure,
      });
  }

  private attachAttemptAbort(claim: CodexNativeHookRelayAttemptClaim): void {
    const { signal } = claim.attempt;
    const onAbort = () => this.releaseAttempt(claim);
    signal.addEventListener("abort", onAbort, { once: true });
    claim.detachAbort = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  }

  private hasClaims(): boolean {
    return this.attemptClaim !== undefined || this.childThreadIds.size > 0;
  }

  private renew(ttlMs?: number): CodexNativeHookRelayRenewal {
    if (this.released || !this.hasClaims()) {
      return "dead";
    }
    const renewal = this.relay.renew(ttlMs);
    if (renewal === "live") {
      return "live";
    }
    if (renewal === "foreign-owner") {
      this.finalizeState("codex_native_hook_relay_foreign_owner");
      return "foreign-owner";
    }
    const claim = this.attemptClaim;
    this.reregisterRoute(claim ? this.claimBinding(claim) : this.retiredBinding(this.attempt));
    return "live";
  }

  private acquireChild(childThreadIdInput: string): (() => void) | undefined {
    const childThreadId = childThreadIdInput.trim();
    if (!childThreadId || this.released || this.childThreadIds.has(childThreadId)) {
      return undefined;
    }
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.childThreadIds.add(childThreadId);
    this.scheduleRenewal();
    let acquired = true;
    return () => {
      if (!acquired) {
        return;
      }
      acquired = false;
      this.childThreadIds.delete(childThreadId);
      if (this.childThreadIds.size === 0) {
        this.clearRenewal();
        if (!this.attemptClaim) {
          this.requestFinalRelease(true);
        }
      }
    };
  }

  private releaseAttempt(
    claim: CodexNativeHookRelayAttemptClaim,
    options: { delay?: boolean } = {},
  ): void {
    if (this.released || this.attemptClaim !== claim) {
      return;
    }
    this.retireAttemptClaim();
    if (this.childThreadIds.size === 0) {
      this.requestFinalRelease(options.delay === true);
    }
  }

  private retireAttemptClaim(): void {
    const claim = this.attemptClaim;
    if (!claim) {
      return;
    }
    this.attemptClaim = undefined;
    claim.detachAbort();
    const binding = this.retiredBinding(claim.attempt);
    if (!this.relay.rebindAttempt?.(binding)) {
      this.reregisterRoute(binding);
    }
  }

  private requestFinalRelease(delay: boolean): void {
    if (this.released || this.hasClaims()) {
      return;
    }
    if (!delay) {
      this.releaseNow("codex_native_hook_relay_released");
      return;
    }
    if (this.cancelPendingUnregister) {
      return;
    }
    this.cancelPendingUnregister = scheduleCodexNativeHookRelayUnregister({
      relay: { unregister: () => this.relay.unregister() },
      hookTimeoutSec: this.hookTimeoutSec,
      beforeUnregister: () => {
        this.cancelPendingUnregister = undefined;
        this.lifetimeAbortController.abort("codex_native_hook_relay_released");
        this.finalizeState("codex_native_hook_relay_released_delayed");
      },
    });
  }

  private scheduleRenewal(): void {
    if (this.renewalTimer || this.released || this.childThreadIds.size === 0) {
      return;
    }
    const delayMs = Math.max(1, Math.min(5 * 60_000, Math.floor(this.ttlMs / 2)));
    this.renewalTimer = setTimeout(() => {
      this.renewalTimer = undefined;
      if (this.released || this.childThreadIds.size === 0) {
        return;
      }
      this.renew(this.ttlMs);
      this.scheduleRenewal();
    }, delayMs);
    this.renewalTimer.unref();
  }

  private clearRenewal(): void {
    if (!this.renewalTimer) {
      return;
    }
    clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
  }

  private releaseNow(reason: string): void {
    this.cancelPendingUnregister?.();
    this.cancelPendingUnregister = undefined;
    this.lifetimeAbortController.abort(reason);
    this.relay.unregister();
    this.finalizeState(reason);
  }

  private finalizeState(reason: string): void {
    if (this.released) {
      return;
    }
    this.released = true;
    embeddedAgentLog.debug("Codex native hook relay route released", {
      relayId: this.relayId,
      reason,
    });
    this.clearRenewal();
    this.attemptClaim?.detachAbort();
    this.attemptClaim = undefined;
    this.childThreadIds.clear();
    if (codexNativeHookRelayOwners.get(this.relayId) === this) {
      codexNativeHookRelayOwners.delete(this.relayId);
    }
  }

  dispose(): void {
    if (this.released) {
      return;
    }
    this.releaseNow("codex_native_hook_relay_disposed");
  }
}

const codexNativeHookRelayOwners = codexNativeHookRelayOwnerRegistry as Map<
  string,
  CodexNativeHookRelayRoute
>;

/** Selects the native hook events Codex should install for the current approval mode. */
export function resolveCodexNativeHookRelayEvents(params: {
  configuredEvents?: readonly NativeHookRelayEvent[];
  appServer: Pick<CodexAppServerRuntimeOptions, "approvalPolicy">;
}): readonly NativeHookRelayEvent[] {
  if (params.configuredEvents?.length) {
    return params.configuredEvents;
  }
  // Codex emits PermissionRequest before the app-server approval reviewer has
  // resolved the command. In native approval modes, let Codex's app-server
  // approval bridge own the real escalation instead of surfacing a stale
  // pre-guardian OpenClaw plugin approval prompt.
  return params.appServer.approvalPolicy === "never"
    ? CODEX_NATIVE_HOOK_RELAY_EVENTS
    : CODEX_NATIVE_HOOK_RELAY_EVENTS_WITH_APP_SERVER_APPROVALS;
}

/** Derives the native hook relay TTL from the turn budget unless explicitly configured. */
export function resolveCodexNativeHookRelayTtlMs(params: {
  explicitTtlMs: number | undefined;
  attemptTimeoutMs: number;
  startupTimeoutMs: number;
  turnStartTimeoutMs: number;
}): number {
  if (params.explicitTtlMs !== undefined) {
    return params.explicitTtlMs;
  }
  const relayBudgetMs =
    params.attemptTimeoutMs +
    params.startupTimeoutMs +
    params.turnStartTimeoutMs +
    CODEX_NATIVE_HOOK_RELAY_TTL_GRACE_MS;
  return Math.max(CODEX_NATIVE_HOOK_RELAY_MIN_TTL_MS, Math.floor(relayBudgetMs));
}

function buildCodexNativeHookRelayId(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  generation: string;
}): string {
  const hash = createHash("sha256");
  hash.update("openclaw:codex:native-hook-relay:v2");
  hash.update("\0");
  hash.update(params.agentId?.trim() || "");
  hash.update("\0");
  hash.update(params.sessionKey?.trim() || params.sessionId);
  hash.update("\0");
  hash.update(params.generation);
  return `codex-${hash.digest("hex").slice(0, 40)}`;
}
