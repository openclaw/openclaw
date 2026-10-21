import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { captureSessionEntryCurrentCheckAsyncInternal } from "../../../config/sessions/session-entry-current-check.js";
import { composeSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { warnPluginSdkDeprecation } from "../../../plugins/sdk-deprecation.js";
import {
  createNativeSessionBindingAuthorityInternal,
  createPreparedNativeSessionBindingAuthority,
  combineNativeSessionBindingAuthorityInternal,
  combinePreparedNativeSessionBindingAuthority,
  readNativeSessionBindingEntries,
  type NativeSessionBindingAuthority,
  type PreparedNativeSessionBindingAuthority,
} from "./binding-authority.js";
import type {
  NativeSessionGenerationParams,
  NativeSessionGenerationReclaimPlan,
  NativeSessionGenerationAdoptionResult,
} from "./binding-generation.js";

/**
 * @deprecated Use resolvePreparedNativeSessionBinding and release its capture; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31.
 */
export async function resolveNativeSessionBindingWithAuthority<TBinding>(
  params: NativeSessionBindingResolveOptions<TBinding> & {
    readBinding: (sessionId?: string) => TBinding | undefined;
  },
) {
  warnPluginSdkDeprecation({
    family: "native-session-binding",
    method: "resolveNativeSessionBindingWithAuthority",
    replacement: "resolvePreparedNativeSessionBinding",
    compatibility: "The legacy binding callback retains its synchronous authority frame.",
  });
  return resolveNativeSessionBindingOwner(params, (authority, previousSessionId) =>
    authority.withCurrent(() => {
      const current = params.readBinding();
      params.assertBinding?.(
        current ?? (previousSessionId ? params.readBinding(previousSessionId) : undefined),
      );
      return current;
    }),
  );
}

/** The caller releases its captured lineage after the binding's final use and cleanup. */
export async function resolvePreparedNativeSessionBinding<TBinding>(
  params: Omit<NativeSessionBindingResolveOptions<TBinding>, "authority" | "generation"> & {
    authority?: PreparedNativeSessionBindingAuthority;
    generation?: PreparedNativeSessionGenerationOperations;
    /** Transfer a prior capture for this target, including cleanup on admission failure. */
    generationAuthority?: RetainedNativeSessionGenerationAuthority;
    readBinding: (sessionId?: string) => Promise<TBinding | undefined>;
  },
): Promise<{
  binding: TBinding | undefined;
  authority: PreparedNativeSessionBindingAuthority;
  release: () => void;
}> {
  const assertAdmissionCurrent = () => {
    params.assertCurrent?.();
    params.signal?.throwIfAborted();
  };
  let captured = params.generationAuthority;
  let active = true;
  const release = () => {
    active = false;
    captured?.release();
  };
  try {
    assertAdmissionCurrent();
    captured ??= params.target?.sessionKey?.trim()
      ? await retainNativeSessionGenerationAuthority({
          ...params,
          target: params.target,
          assertCurrent: assertAdmissionCurrent,
        })
      : undefined;
    const authority = combinePreparedNativeSessionBindingAuthority(
      params.authority,
      captured?.authority,
      createPreparedNativeSessionBindingAuthority({
        lineage: [],
        source: composeSessionSourceAssertion([], () => {
          if (!active) {
            throw new Error("Native session binding scope was released");
          }
        }),
        entryChecks: [],
        assertCurrent: assertAdmissionCurrent,
      }),
    );
    const readBinding = async (previousSessionId?: string) => {
      authority.assertCurrent();
      const current = await params.readBinding();
      const ownership =
        current ?? (previousSessionId ? await params.readBinding(previousSessionId) : undefined);
      return authority.withCurrent(() => {
        params.assertBinding?.(ownership);
        return current;
      });
    };
    let binding = await readBinding(captured?.previousSessionId);
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
      binding = await readBinding();
    } else if (!binding) {
      params.assertBinding?.(binding);
    }
    return { binding, authority, release };
  } catch (error) {
    release();
    throw error;
  }
}

type NativeSessionBindingResolveOptions<TBinding> = Omit<
  NativeSessionGenerationParams,
  "target"
> & {
  target?: NativeSessionGenerationParams["target"];
  generation?: NativeSessionGenerationOperationsV2;
  reclaimStale?: boolean;
  signal?: AbortSignal;
  assertBinding?: (binding: TBinding | undefined) => void;
  authority?: NativeSessionBindingAuthority;
};

async function resolveNativeSessionBindingOwner<TBinding>(
  params: NativeSessionBindingResolveOptions<TBinding>,
  readBinding: (
    authority: NativeSessionBindingAuthority,
    previousSessionId?: string,
  ) => Promise<TBinding | undefined>,
): Promise<{
  binding: TBinding | undefined;
  authority: NativeSessionBindingAuthority;
}> {
  const assertAdmissionCurrent = () => {
    params.assertCurrent?.();
    params.signal?.throwIfAborted();
  };
  assertAdmissionCurrent();
  const captured = params.target?.sessionKey?.trim()
    ? await prepareNativeSessionGenerationAuthorityInternal({
        ...params,
        target: params.target,
        assertCurrent: assertAdmissionCurrent,
      })
    : undefined;
  const authority = combineNativeSessionBindingAuthorityInternal(
    params.authority,
    captured?.authority ?? createNativeSessionBindingAuthorityInternal([], assertAdmissionCurrent),
  );
  let binding = await readBinding(authority, captured?.previousSessionId);
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
    binding = await readBinding(authority);
  } else if (!binding) {
    params.assertBinding?.(binding);
  }
  return { binding, authority };
}

/** Let the authoritative OpenClaw generation adopt its predecessor or reclaim a stale row. */
export async function reclaimNativeSessionGenerationWithAuthority(
  params: NativeSessionGenerationParams & {
    generation: PreparedNativeSessionGenerationOperations;
    reclaimStale?: boolean;
  },
): Promise<boolean> {
  params.assertCurrent?.();
  if (!params.target.sessionKey?.trim()) {
    return true;
  }
  const authority = await retainNativeSessionGenerationAuthority(params);
  try {
    if (authority.state === "superseded") {
      return false;
    }
    return await reclaimPreparedGeneration(params, authority);
  } finally {
    authority.release();
  }
}

/** Select lineage once; the session owner publishes every in-process change until release. */
export async function retainNativeSessionGenerationAuthority(
  params: NativeSessionGenerationParams,
) {
  params.assertCurrent?.();
  const read = {
    agentId: params.target.agentId,
    sessionKey: params.target.sessionKey?.trim() ?? "",
    storePath:
      params.storePath?.trim() ||
      resolveSessionStorePathCore(params.config?.session?.store, {
        agentId: params.target.agentId,
      }),
  };
  let captured:
    | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
    | undefined;
  let failed = false;
  try {
    if (read.sessionKey) {
      captured = await captureSessionEntryCurrentCheckAsyncInternal({
        ...read,
        matchGeneration: false,
        fields: ["sessionId", "previousSessionId"],
      });
    }
    params.assertCurrent?.();
  } catch {
    captured?.release();
    captured = undefined;
    params.assertCurrent?.();
    failed = true;
  }
  const entry = failed ? null : captured?.entry;
  const current = entry?.sessionId === params.target.sessionId;
  const state = entry === undefined ? "ephemeral" : current ? "current" : "superseded";
  const previousSessionId = current ? entry?.previousSessionId : undefined;
  // An unpersisted target has no selected lineage; later creation does not adopt it implicitly.
  if (state !== "current") {
    captured?.release();
    captured = undefined;
  }
  let active = true;
  const refuse = (): never => {
    throw params.createSupersededError(params.target.sessionId);
  };
  const source = composeSessionSourceAssertion([captured?.source], (assertSource) => {
    if (!active || state === "superseded") {
      refuse();
    }
    try {
      assertSource();
    } catch {
      refuse();
    }
  });
  const entryCurrent = captured?.entryCurrent;
  const authority = createPreparedNativeSessionBindingAuthority({
    lineage: current
      ? [
          {
            read,
            sessionId: params.target.sessionId,
            previousSessionId,
            createSupersededError: params.createSupersededError,
          },
        ]
      : [],
    source,
    entryChecks: entryCurrent
      ? [
          {
            source: entryCurrent.source,
            assertCurrent: (facts) => {
              if (!active) {
                refuse();
              }
              try {
                entryCurrent.assertCurrent(facts);
              } catch {
                refuse();
              }
            },
          },
        ]
      : [],
    assertCurrent: () => {
      params.assertCurrent?.();
      if (state === "superseded") {
        refuse();
      }
    },
  });
  return {
    state,
    previousSessionId,
    authority,
    release() {
      if (active) {
        active = false;
        captured?.release();
      }
    },
  } as const;
}

export type RetainedNativeSessionGenerationAuthority = Awaited<
  ReturnType<typeof retainNativeSessionGenerationAuthority>
>;

/** @deprecated Use retainNativeSessionGenerationAuthority and release its capture; removed in the first January 2027 stable release, after the final compatibility day 2026-12-31. */
export async function prepareNativeSessionGenerationAuthority(
  params: NativeSessionGenerationParams,
) {
  warnPluginSdkDeprecation({
    family: "native-session-binding",
    method: "prepareNativeSessionGenerationAuthority",
    replacement: "retainNativeSessionGenerationAuthority",
  });
  return prepareNativeSessionGenerationAuthorityInternal(params);
}

async function prepareNativeSessionGenerationAuthorityInternal(
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
  const authority = createNativeSessionBindingAuthorityInternal(
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

type NativeSessionGenerationAuthority = Awaited<
  ReturnType<typeof prepareNativeSessionGenerationAuthority>
>;

/** Backend storage translates these decisions into its own record schema and native policy. */
export type NativeSessionGenerationOperationsV2<
  TAuthority extends NativeSessionBindingAuthority = NativeSessionBindingAuthority,
> = {
  prepareReclaim: () => Promise<NativeSessionGenerationReclaimPlan>;
  adopt: (
    expectedPreviousSessionId: string,
    authority: TAuthority,
  ) => Promise<NativeSessionGenerationAdoptionResult>;
  reclaim: (expectedPreviousSessionId: string, authority: TAuthority) => Promise<boolean>;
};

export type PreparedNativeSessionGenerationOperations =
  NativeSessionGenerationOperationsV2<PreparedNativeSessionBindingAuthority>;

async function reclaimPreparedGeneration<TAuthority extends NativeSessionBindingAuthority>(
  params: {
    generation: NativeSessionGenerationOperationsV2<TAuthority>;
    reclaimStale?: boolean;
  },
  authority: Omit<NativeSessionGenerationAuthority, "authority"> & { authority: TAuthority },
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
  if (authority.previousSessionId === plan.expectedPreviousSessionId) {
    const adopted = await params.generation.adopt(authority.previousSessionId, authority.authority);
    if (adopted !== "absent") {
      return adopted !== "conflict";
    }
  }
  if (params.reclaimStale === false) {
    return false;
  }
  return params.generation.reclaim(plan.expectedPreviousSessionId, authority.authority);
}
