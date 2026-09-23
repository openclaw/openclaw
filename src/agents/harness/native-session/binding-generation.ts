import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

/** Resolve host lineage before selecting a native queue, catalog, or connection. */
export async function resolveNativeSessionBinding<TBinding>(
  params: Omit<NativeSessionGenerationParams, "target"> & {
    target?: NativeSessionGenerationTarget;
    readBinding: (sessionId?: string) => TBinding | undefined;
    generation?: NativeSessionGenerationOperations;
    reclaimStale?: boolean;
    signal?: AbortSignal;
    assertBinding?: (binding: TBinding | undefined) => void;
  },
): Promise<{ binding: TBinding | undefined; assertCurrent: () => void }> {
  let assertCurrent = params.assertCurrent ?? (() => {});
  const assertAdmissionCurrent = () => {
    // Cancellation errors and cleanup behavior remain with each backend caller.
    assertCurrent();
    params.signal?.throwIfAborted();
  };
  assertAdmissionCurrent();
  params.assertBinding?.(readOwnershipBinding(params));
  const authority = params.target?.sessionKey?.trim()
    ? captureNativeSessionGenerationAuthority({ ...params, target: params.target, assertCurrent })
    : undefined;
  assertCurrent = authority?.assertCurrent ?? assertCurrent;
  assertAdmissionCurrent();
  let binding = params.readBinding();
  if (!binding && authority && params.target && params.generation) {
    if (
      !(await reclaimPreparedGeneration(
        { ...params, generation: params.generation, reclaimStale: params.reclaimStale === true },
        authority,
        assertAdmissionCurrent,
      )) &&
      params.reclaimStale
    ) {
      throw params.createSupersededError(params.target.sessionId);
    }
    binding = params.readBinding();
  }
  assertAdmissionCurrent();
  params.assertBinding?.(binding);
  // A committed binding is not host authority. Carry its exact lineage proof through waits.
  return { binding, assertCurrent };
}

/** Let the authoritative OpenClaw generation adopt its predecessor or reclaim a stale row. */
export async function reclaimNativeSessionGeneration(
  params: NativeSessionGenerationParams & {
    generation: NativeSessionGenerationOperations;
    onHostGenerationVerified?: (assertHostGeneration: () => void) => void;
    reclaimStale?: boolean;
  },
): Promise<boolean> {
  params.assertCurrent?.();
  if (!params.target.sessionKey?.trim()) {
    return true;
  }
  const authority = captureNativeSessionGenerationAuthority(params);
  if (authority.state === "superseded") {
    return false;
  }
  return reclaimPreparedGeneration(params, authority);
}

/** Capture the host generation and predecessor together, then revalidate both after waits. */
export function captureNativeSessionGenerationAuthority(params: NativeSessionGenerationParams) {
  const readEntry = () => {
    try {
      return readBindingSessionEntry(params);
    } catch {
      // Failed host reads cannot authorize a durable native binding.
      return null;
    }
  };
  const entry = readEntry();
  const current = entry?.sessionId === params.target.sessionId;
  const state: "current" | "ephemeral" | "superseded" =
    entry === undefined ? "ephemeral" : current ? "current" : "superseded";
  const previousSessionId = current ? entry.previousSessionId : undefined;
  const assertHostCurrent = () => {
    if (state === "ephemeral") {
      return;
    }
    const latest = readEntry();
    if (
      state !== "current" ||
      !latest ||
      latest.sessionId !== params.target.sessionId ||
      latest.previousSessionId !== previousSessionId
    ) {
      throw params.createSupersededError(params.target.sessionId);
    }
  };
  return {
    state,
    previousSessionId,
    assertHostCurrent,
    assertCurrent(this: void) {
      params.assertCurrent?.();
      assertHostCurrent();
    },
  };
}

type NativeSessionGenerationTarget = {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
};

type NativeSessionGenerationParams = {
  target: NativeSessionGenerationTarget;
  config?: OpenClawConfig;
  storePath?: string;
  assertCurrent?: () => void;
  createSupersededError: (sessionId: string) => Error;
};

type NativeSessionGenerationAuthority = ReturnType<typeof captureNativeSessionGenerationAuthority>;

export type NativeSessionGenerationReclaimPlan =
  | { kind: "resolved"; result: boolean }
  | { kind: "verify"; expectedPreviousSessionId: string };

export type NativeSessionGenerationAdoptionResult = "absent" | "current" | "adopted" | "conflict";

/** Backend storage translates these decisions into its own record schema and native policy. */
export type NativeSessionGenerationOperations = {
  prepareReclaim: () => Promise<NativeSessionGenerationReclaimPlan>;
  adopt: (
    expectedPreviousSessionId: string,
    assertCurrent: () => void,
  ) => Promise<NativeSessionGenerationAdoptionResult>;
  reclaim: (expectedPreviousSessionId: string, assertCurrent: () => void) => Promise<boolean>;
};

async function reclaimPreparedGeneration(
  params: {
    generation: NativeSessionGenerationOperations;
    reclaimStale?: boolean;
    onHostGenerationVerified?: (assertHostGeneration: () => void) => void;
  },
  authority: NativeSessionGenerationAuthority,
  assertCurrent = authority.assertCurrent,
): Promise<boolean> {
  const plan = await params.generation.prepareReclaim();
  assertCurrent();
  if (plan.kind === "resolved") {
    return plan.result;
  }
  if (authority.state !== "current") {
    return false;
  }
  params.onHostGenerationVerified?.(authority.assertHostCurrent);
  if (authority.previousSessionId === plan.expectedPreviousSessionId) {
    const adopted = await params.generation.adopt(authority.previousSessionId, assertCurrent);
    if (adopted !== "absent") {
      return adopted !== "conflict";
    }
  }
  if (params.reclaimStale === false) {
    return false;
  }
  return params.generation.reclaim(plan.expectedPreviousSessionId, assertCurrent);
}

function readOwnershipBinding<TBinding>(params: {
  target?: NativeSessionGenerationTarget;
  config?: OpenClawConfig;
  storePath?: string;
  readBinding: (sessionId?: string) => TBinding | undefined;
}): TBinding | undefined {
  const binding = params.readBinding();
  if (binding || !params.target) {
    return binding;
  }
  const entry = readBindingSessionEntry({ ...params, target: params.target });
  return entry?.sessionId === params.target.sessionId && entry.previousSessionId
    ? params.readBinding(entry.previousSessionId)
    : undefined;
}

function readBindingSessionEntry(params: {
  target: NativeSessionGenerationTarget;
  config?: OpenClawConfig;
  storePath?: string;
}) {
  const { target } = params;
  return target.sessionKey?.trim()
    ? loadSessionEntryReadOnly({
        agentId: target.agentId,
        sessionKey: target.sessionKey.trim(),
        storePath:
          params.storePath?.trim() ||
          resolveSessionStorePathCore(params.config?.session?.store, { agentId: target.agentId }),
        hydrateSkillPromptRefs: false,
        readConsistency: "latest",
      })
    : undefined;
}
