/** Canonical operational instance and optional enabled execution-identity evidence. */
import { randomUUID } from "node:crypto";
import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionFacts,
  type ExecutionIdentityAdmissionToken,
} from "../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../audit/execution-identity-spawn-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  getAgentRunLifecycleGeneration,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** Operational lifecycle correlation. This is never identity or authorization evidence. */
export type OperationalRunInstanceRef = Readonly<{
  instanceId: string;
  runId: string;
}>;

/** Exact context carried by one admitted execution and every retry/fallback it owns. */
export type AdmittedRunContext = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  executionIdentityToken?: ExecutionIdentityAdmissionToken;
}>;

export type AdmittedRunOperatorAuthority = Readonly<{
  profileId: string;
  scopes: readonly string[];
  assertCurrent: () => void;
  signal?: AbortSignal;
  /** Opaque original source identity used only to compare compatible queued input. */
  source?: object;
  /** Retains the original source independently of a foreground run or request. */
  retain?: () => () => void;
}>;

const operatorAuthorityIssuers = resolveGlobalSingleton(
  Symbol.for("openclaw.admittedRunOperatorAuthorities"),
  () => new WeakSet<object>(),
);

/** Host-only construction; public reply options cannot manufacture a source capability. */
export function createAdmittedRunOperatorAuthority(
  source: AdmittedRunOperatorAuthority,
): AdmittedRunOperatorAuthority {
  const check = source.assertCurrent;
  const signal = source.signal;
  let revoked = false;
  const authority = Object.freeze({
    profileId: source.profileId,
    scopes: Object.freeze([...source.scopes]),
    source: source.source ?? Object.freeze({}),
    signal,
    retain: source.retain,
    assertCurrent: () => {
      if (revoked) {
        throw new Error("operator execution authority is no longer active");
      }
      try {
        signal?.throwIfAborted();
        check();
      } catch (error) {
        revoked = true;
        throw error;
      }
    },
  });
  operatorAuthorityIssuers.add(authority);
  return authority;
}

export function assertAdmittedRunOperatorAuthority(
  authority: unknown,
): asserts authority is AdmittedRunOperatorAuthority {
  if (!authority || typeof authority !== "object" || !operatorAuthorityIssuers.has(authority)) {
    throw new Error("operator run authority must be issued by the host");
  }
}

export type PreparedAgentRunAdmission = Readonly<{
  operationalRunInstance: OperationalRunInstanceRef;
  /** Exact post-prepare owner; repeated fallback/retry returns the same object. */
  admit: (
    runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"],
    runtimeInstanceId?: string,
  ) => Promise<AdmittedRunContext>;
  /** Checks latched source revocation after normal close; never grants execution authority. */
  assertSourceCurrent: () => void;
  /** Host-only source restriction available before the runtime prepares its tools. */
  readOperatorAuthority?: () => AdmittedRunOperatorAuthority | undefined;
  /** Idempotently closes the exact delegated approval lease, if admission occurred. */
  close: () => void;
}>;

type DelegatedAuthorityLease = {
  authority: AgentRunDelegatedAuthority;
  foregroundClosed: boolean;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

const delegatedAuthorityLeases = new WeakMap<AdmittedRunContext, DelegatedAuthorityLease>();
const activeNativeHookRecoveryLeases = new Map<
  string,
  { lease: DelegatedAuthorityLease; releaseOperatorAuthority?: () => void }
>();

function bindAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
  assertSourceCurrent?: () => void,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): void {
  const authority = claimAgentRunDelegatedAuthority(
    context.operationalRunInstance,
    assertSourceCurrent,
  );
  const previousRecovery = activeNativeHookRecoveryLeases.get(context.operationalRunInstance.runId);
  activeNativeHookRecoveryLeases.delete(context.operationalRunInstance.runId);
  previousRecovery?.releaseOperatorAuthority?.();
  const lease = { authority, foregroundClosed: false, assertSourceCurrent, operatorAuthority };
  delegatedAuthorityLeases.set(context, lease);
}

/** Reads the immutable outer-run authority without reviving a closed claim. */
export function getAdmittedRunDelegatedAuthority(
  context: AdmittedRunContext,
): AgentRunDelegatedAuthority | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  return lease && !lease.foregroundClosed && validateAgentRunDelegatedAuthority(lease.authority)
    ? lease.authority
    : undefined;
}

/** Captures the operator's source lifetime from a live run, including for detached children. */
export function readAdmittedRunOperatorAuthority(
  context: AdmittedRunContext | undefined,
): AdmittedRunOperatorAuthority | undefined {
  if (!context) {
    return undefined;
  }
  const operatorAuthority = delegatedAuthorityLeases.get(context)?.operatorAuthority;
  if (!operatorAuthority) {
    return undefined;
  }
  if (!getAdmittedRunDelegatedAuthority(context)) {
    throw new Error("admitted run operator authority is no longer active");
  }
  return operatorAuthority;
}

/** Reads the same source ceiling used by admission without minting run authority. */
export function readPreparedRunOperatorAuthority(
  prepared: PreparedAgentRunAdmission | undefined,
): AdmittedRunOperatorAuthority | undefined {
  const authority = prepared?.readOperatorAuthority?.();
  if (authority !== undefined) {
    assertAdmittedRunOperatorAuthority(authority);
  }
  return authority;
}

/** Captures an exact admitted-run assertion for work that may cross an await boundary. */
export function resolveAdmittedRunActiveAssertion(
  context: AdmittedRunContext,
  signal?: AbortSignal,
): (() => void) | undefined {
  const operationalRunInstance = context.operationalRunInstance;
  const authority = getAdmittedRunDelegatedAuthority(context);
  if (!authority) {
    return undefined;
  }
  return () => {
    if (
      signal?.aborted ||
      context.operationalRunInstance !== operationalRunInstance ||
      getAdmittedRunDelegatedAuthority(context) !== authority
    ) {
      throw new Error("admitted run authority is no longer active");
    }
  };
}

/** Idempotently compare-releases the authority captured by this admission. */
export function closeAdmittedRunDelegatedAuthority(context: AdmittedRunContext): boolean {
  const lease = delegatedAuthorityLeases.get(context);
  if (!lease || lease.foregroundClosed) {
    return false;
  }
  lease.foregroundClosed = true;
  releaseAgentRunDelegatedAuthority(lease.authority);
  return true;
}

type AdmittedRunBeforeToolCallRecovery = Readonly<{
  assertActive: () => void;
  release: () => void;
}>;

/** Recovery-only lease for the already-created native pre-tool policy callback. */
export function retainAdmittedRunBeforeToolCallRecovery(
  context: AdmittedRunContext,
): AdmittedRunBeforeToolCallRecovery | undefined {
  const lease = delegatedAuthorityLeases.get(context);
  const runId = context.operationalRunInstance.runId;
  if (
    !lease ||
    lease.foregroundClosed ||
    activeNativeHookRecoveryLeases.has(runId) ||
    !validateAgentRunDelegatedAuthority(lease.authority)
  ) {
    return undefined;
  }
  const recovery = {
    lease,
    releaseOperatorAuthority: lease.operatorAuthority?.retain?.(),
  };
  activeNativeHookRecoveryLeases.set(runId, recovery);
  const assertActive = () => {
    // Retaining native policy outlives the foreground claim, never its source owner.
    lease.assertSourceCurrent?.();
    if (
      getAgentRunLifecycleGeneration() !== lease.authority.lifecycleGeneration ||
      activeNativeHookRecoveryLeases.get(runId) !== recovery
    ) {
      throw new Error("admitted run native hook recovery is no longer active");
    }
  };
  return Object.freeze({
    assertActive,
    release: () => {
      if (activeNativeHookRecoveryLeases.get(runId) === recovery) {
        activeNativeHookRecoveryLeases.delete(runId);
        recovery.releaseOperatorAuthority?.();
      }
    },
  });
}

type ExecutionIdentityRecoveryAdmission = Readonly<{
  /** Recovery retries never manufacture replacement identity when exact evidence is absent. */
  retryOnly: boolean;
  consume: (runId: string) => Readonly<{
    accepted: boolean;
    token?: ExecutionIdentityAdmissionToken;
  }>;
}>;

/** Creates a one-shot recovery admission owned by the durable recovery resolver. */
export function createExecutionIdentityRecoveryAdmission(params: {
  retryOnly: boolean;
  token?: ExecutionIdentityAdmissionToken;
  expectedOperationalRunId?: string;
}): ExecutionIdentityRecoveryAdmission {
  let consumed = false;
  return Object.freeze({
    retryOnly: params.retryOnly,
    consume: (runId: string) => {
      if (consumed) {
        return Object.freeze({ accepted: false });
      }
      consumed = true;
      if (
        params.expectedOperationalRunId !== undefined &&
        params.expectedOperationalRunId !== runId
      ) {
        return Object.freeze({ accepted: false });
      }
      // The trusted recovery resolver binds the current operational owner separately.
      // Without that explicit binding, only the token's original run may redeem it.
      const token =
        params.expectedOperationalRunId !== undefined || params.token?.runId === runId
          ? params.token
          : undefined;
      return Object.freeze({ accepted: true, ...(token ? { token } : {}) });
    },
  });
}

export function createOperationalRunInstanceRef(runId: string): OperationalRunInstanceRef {
  return Object.freeze({ instanceId: randomUUID(), runId });
}

/** Prepares a system-owned run without selecting its eventual execution runtime early. */
export function prepareSystemAgentRunAdmission(
  cfg: OpenClawConfig,
  runId: string,
  agentId: string,
  boundary: string,
  assertSourceCurrent?: () => void,
  operatorAuthority?: AdmittedRunOperatorAuthority,
): PreparedAgentRunAdmission {
  return prepareAgentRunAdmission({
    cfg,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    assertSourceCurrent,
    operatorAuthority,
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary, state: "present" },
    },
  });
}

/**
 * Freezes ingress facts before preparation while deferring allocation/capture until the
 * authoritative runtime owner is selected immediately before execution.
 */
export function prepareAgentRunAdmission(params: {
  cfg: OpenClawConfig;
  facts: Omit<ExecutionIdentityAdmissionFacts, "runtime">;
  operationalRunInstance: OperationalRunInstanceRef;
  recovery?: ExecutionIdentityRecoveryAdmission;
  onAdmitted?: (context: AdmittedRunContext) => void | Promise<void>;
  assertSourceCurrent?: () => void;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): PreparedAgentRunAdmission {
  const operationalRunInstance = params.operationalRunInstance;
  if (operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  const sourceAssertion = params.assertSourceCurrent;
  const operatorAuthority = params.operatorAuthority;
  if (operatorAuthority !== undefined) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
  }
  const assertOperatorCurrent = operatorAuthority?.assertCurrent;
  const releaseOperatorAuthority = operatorAuthority?.retain?.();
  let sourceClosed = false;
  const assertSourceCurrent =
    (sourceAssertion || assertOperatorCurrent) &&
    (() => {
      if (sourceClosed) {
        throw new Error("source execution authority is no longer active");
      }
      try {
        sourceAssertion?.();
        assertOperatorCurrent?.();
      } catch (error) {
        sourceClosed = true;
        throw error;
      }
    });
  let admittedRuntimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"] | undefined;
  let admittedRuntimeInstanceId: string | undefined;
  let admitted: Promise<AdmittedRunContext> | undefined;
  let admittedContext: AdmittedRunContext | undefined;
  let closed = false;
  return Object.freeze({
    operationalRunInstance,
    assertSourceCurrent: () => assertSourceCurrent?.(),
    readOperatorAuthority: () => {
      if (operatorAuthority) {
        if (closed) {
          throw new Error("prepared operator authority is no longer active");
        }
        operatorAuthority.assertCurrent();
      }
      return operatorAuthority;
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (admittedContext) {
        closeAdmittedRunDelegatedAuthority(admittedContext);
      } else {
        void admitted?.then(closeAdmittedRunDelegatedAuthority).catch(() => undefined);
      }
      releaseOperatorAuthority?.();
    },
    admit: (runtimeKind, runtimeInstanceId) => {
      if (closed) {
        return Promise.reject(new Error("prepared execution context is already closed"));
      }
      // The first runtime that actually executes fixes the captured runtime fact.
      // Later fallback paths reuse this exact admission instead of recapturing identity.
      const fixedRuntimeKind = (admittedRuntimeKind ??= runtimeKind);
      admittedRuntimeInstanceId ??= runtimeInstanceId?.trim() || undefined;
      admitted ??= (async () => {
        assertSourceCurrent?.();
        const facts = executionIdentitySpawnAdmission({
          operation: "attach",
          value: { ...params.facts, runtime: { kind: fixedRuntimeKind } },
          extra: executionIdentitySpawnAdmission({ operation: "read", value: params.facts }),
        });
        const context = admitPreparedAgentRun({
          cfg: params.cfg,
          facts,
          operationalRunInstance,
          runtimeInstanceId: admittedRuntimeInstanceId,
          ...(params.recovery ? { recovery: params.recovery } : {}),
        });
        bindAdmittedRunDelegatedAuthority(context, assertSourceCurrent, operatorAuthority);
        admittedContext = context;
        try {
          await params.onAdmitted?.(context);
          if (closed || !getAdmittedRunDelegatedAuthority(context)) {
            throw new Error("prepared execution authority closed during admission");
          }
          return context;
        } catch (error) {
          closeAdmittedRunDelegatedAuthority(context);
          throw error;
        }
      })();
      return admitted;
    },
  });
}

/** Resolves a host-only continuation or validates an already-admitted internal caller. */
export async function resolvePreparedRunAdmission(params: {
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
  runtimeInstanceId?: string;
  admittedRunContext?: AdmittedRunContext;
  preparedRunAdmission?: PreparedAgentRunAdmission;
}): Promise<AdmittedRunContext> {
  if (params.admittedRunContext && params.preparedRunAdmission) {
    throw new Error("run cannot carry both prepared and admitted execution contexts");
  }
  const admitted = params.preparedRunAdmission
    ? await params.preparedRunAdmission.admit(params.runtimeKind, params.runtimeInstanceId)
    : params.admittedRunContext;
  if (!admitted || admitted.operationalRunInstance.runId !== params.runId) {
    throw new Error("prepared execution context is unavailable or disagrees with the run");
  }
  const lease = delegatedAuthorityLeases.get(admitted);
  if (lease && !getAdmittedRunDelegatedAuthority(admitted)) {
    throw new Error("prepared execution authority is no longer active");
  }
  return admitted;
}

function consumeRecoveryAdmission(params: {
  admission: ExecutionIdentityRecoveryAdmission | undefined;
  runId: string;
}): Readonly<{ accepted: boolean; token?: ExecutionIdentityAdmissionToken }> {
  const consumed: Readonly<{
    accepted: boolean;
    token?: ExecutionIdentityAdmissionToken;
  }> =
    typeof params.admission?.consume === "function"
      ? params.admission.consume(params.runId)
      : Object.freeze({ accepted: false });
  const token = consumed.token;
  if (!token) {
    return consumed;
  }
  return Object.freeze({
    accepted: consumed.accepted,
    token: Object.isFrozen(token) ? token : Object.freeze(token),
  });
}

/**
 * Owns the single post-prepare allocation/adoption/capture decision for an execution.
 * Queue loss remains audit loss only; the admitted execution keeps its exact token object.
 */
function admitPreparedAgentRun(params: {
  cfg: OpenClawConfig;
  facts: ExecutionIdentityAdmissionFacts;
  operationalRunInstance: OperationalRunInstanceRef;
  runtimeInstanceId?: string;
  recovery?: ExecutionIdentityRecoveryAdmission;
}): AdmittedRunContext {
  if (params.operationalRunInstance.runId !== params.facts.runId) {
    throw new Error("operational run instance disagrees with prepared admission");
  }
  const operationalRunInstance = params.operationalRunInstance;
  // Consume the one-shot recovery lease even while collection is disabled so a
  // later operational instance cannot adopt evidence that belonged to this run.
  const recovery = consumeRecoveryAdmission({
    admission: params.recovery,
    runId: params.facts.runId,
  });
  if (!isExecutionIdentityCollectionEnabled(params.cfg)) {
    return Object.freeze({ operationalRunInstance });
  }
  const executionIdentityToken =
    recovery.token ??
    (!params.recovery || (recovery.accepted && !params.recovery.retryOnly)
      ? createExecutionIdentityAdmissionToken(params.facts.runId)
      : undefined);
  if (!executionIdentityToken) {
    return Object.freeze({ operationalRunInstance });
  }

  enqueueExecutionIdentityContextAtAdmission(params.facts, {
    enabled: true,
    token: executionIdentityToken,
    runtimeInstanceId: params.runtimeInstanceId,
    retryOnly: params.recovery?.retryOnly === true,
  });
  return Object.freeze({ operationalRunInstance, executionIdentityToken });
}
