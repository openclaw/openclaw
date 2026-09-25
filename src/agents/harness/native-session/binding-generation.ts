import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  createNativeSessionBindingAuthority,
  combineNativeSessionBindingAuthority,
  readNativeSessionBindingEntries,
  type NativeSessionBindingAuthority,
} from "./binding-authority.js";

/** Resolve host lineage before selecting a native queue, catalog, or connection. */
export async function resolveNativeSessionBinding<TBinding>(
  params: Omit<NativeSessionGenerationParams, "target"> & {
    target?: NativeSessionGenerationTarget;
    readBinding: (sessionId?: string) => TBinding | undefined;
    generation?: NativeSessionGenerationOperations;
    reclaimStale?: boolean;
    signal?: AbortSignal;
    assertBinding?: (binding: TBinding | undefined) => void;
    authority?: NativeSessionBindingAuthority;
  },
): Promise<{
  binding: TBinding | undefined;
  assertCurrent: () => void;
  assertLegacyCurrent: () => void;
  authority: NativeSessionBindingAuthority;
}> {
  const assertAdmissionCurrent = () => {
    params.assertCurrent?.();
    params.signal?.throwIfAborted();
  };
  assertAdmissionCurrent();
  const captured = params.target?.sessionKey?.trim()
    ? await captureNativeSessionGenerationAuthority({
        ...params,
        target: params.target,
        assertCurrent: assertAdmissionCurrent,
      })
    : undefined;
  const authority = combineNativeSessionBindingAuthority(
    params.authority,
    captured?.authority ?? createNativeSessionBindingAuthority([], assertAdmissionCurrent),
  );
  let binding = await authority.withCurrent(() => {
    const current = params.readBinding();
    params.assertBinding?.(
      current ??
        (captured?.previousSessionId ? params.readBinding(captured.previousSessionId) : undefined),
    );
    return current;
  });
  if (!binding && captured && params.target && params.generation) {
    if (
      !(await reclaimPreparedGeneration(
        { ...params, generation: params.generation, reclaimStale: params.reclaimStale === true },
        { ...captured, authority },
        assertAdmissionCurrent,
      )) &&
      params.reclaimStale
    ) {
      throw params.createSupersededError(params.target.sessionId);
    }
    binding = await authority.withCurrent(() => {
      const current = params.readBinding();
      params.assertBinding?.(current);
      return current;
    });
  } else if (!binding) {
    params.assertBinding?.(binding);
  }
  return {
    binding,
    assertCurrent: authority.assertLegacyCurrent,
    assertLegacyCurrent: authority.assertLegacyCurrent,
    authority,
  };
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
  const authority = await captureNativeSessionGenerationAuthority(params);
  if (authority.state === "superseded") {
    return false;
  }
  return reclaimPreparedGeneration(params, authority);
}

/** Capture the host generation and predecessor together, then revalidate both after waits. */
export async function captureNativeSessionGenerationAuthority(
  params: NativeSessionGenerationParams,
) {
  const read = {
    agentId: params.target.agentId,
    sessionKey: params.target.sessionKey?.trim() ?? "",
    storePath:
      params.storePath?.trim() ||
      resolveSessionStorePathCore(params.config?.session?.store, {
        agentId: params.target.agentId,
      }),
  };
  const entry = await (async () => {
    try {
      return read.sessionKey
        ? await readNativeSessionBindingEntries([read], ([candidate]) => {
            params.assertCurrent?.();
            return candidate;
          })
        : undefined;
    } catch {
      params.assertCurrent?.();
      return null;
    }
  })();
  const current = entry?.sessionId === params.target.sessionId;
  const state = entry === undefined ? "ephemeral" : current ? "current" : "superseded";
  const previousSessionId = current ? entry?.previousSessionId : undefined;
  const authority = createNativeSessionBindingAuthority(
    state === "current"
      ? [
          {
            read,
            sessionId: params.target.sessionId,
            previousSessionId,
            createSupersededError: params.createSupersededError,
          },
        ]
      : [],
    () => {
      params.assertCurrent?.();
      if (state === "superseded") {
        throw params.createSupersededError(params.target.sessionId);
      }
    },
  );
  return { state, previousSessionId, authority } as const;
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

type NativeSessionGenerationAuthority = Awaited<
  ReturnType<typeof captureNativeSessionGenerationAuthority>
>;

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
    authority?: NativeSessionBindingAuthority,
  ) => Promise<NativeSessionGenerationAdoptionResult>;
  reclaim: (
    expectedPreviousSessionId: string,
    assertCurrent: () => void,
    authority?: NativeSessionBindingAuthority,
  ) => Promise<boolean>;
};

async function reclaimPreparedGeneration(
  params: {
    generation: NativeSessionGenerationOperations;
    reclaimStale?: boolean;
    onHostGenerationVerified?: (assertHostGeneration: () => void) => void;
  },
  authority: NativeSessionGenerationAuthority,
  assertCurrent = authority.authority.assertCurrent,
): Promise<boolean> {
  const plan = await params.generation.prepareReclaim();
  await authority.authority.withCurrent(assertCurrent);
  if (plan.kind === "resolved") {
    return plan.result;
  }
  if (authority.state !== "current") {
    return false;
  }
  params.onHostGenerationVerified?.(authority.authority.assertLegacyCurrent);
  if (authority.previousSessionId === plan.expectedPreviousSessionId) {
    const adopted = await params.generation.adopt(
      authority.previousSessionId,
      assertCurrent,
      authority.authority,
    );
    if (adopted !== "absent") {
      return adopted !== "conflict";
    }
  }
  if (params.reclaimStale === false) {
    return false;
  }
  return params.generation.reclaim(
    plan.expectedPreviousSessionId,
    assertCurrent,
    authority.authority,
  );
}
