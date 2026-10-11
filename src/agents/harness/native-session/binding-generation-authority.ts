import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { warnPluginSdkDeprecation } from "../../../plugins/sdk-deprecation.js";
import {
  createNativeSessionBindingAuthority,
  combineNativeSessionBindingAuthority,
  readNativeSessionBindingEntries,
  type NativeSessionBindingAuthority,
} from "./binding-authority.js";
import type {
  NativeSessionGenerationParams,
  NativeSessionGenerationReclaimPlan,
  NativeSessionGenerationAdoptionResult,
} from "./binding-generation.js";

/**
 * @deprecated Use resolveNativeSessionBindingWithAuthorityV2; removed in the next Plugin SDK major.
 */
export async function resolveNativeSessionBindingWithAuthority<TBinding>(
  params: NativeSessionBindingResolveOptions<TBinding> & {
    readBinding: (sessionId?: string) => TBinding | undefined;
  },
) {
  warnPluginSdkDeprecation({
    family: "native-session-binding",
    method: "resolveNativeSessionBindingWithAuthority",
    replacement: "resolveNativeSessionBindingWithAuthorityV2",
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

/** Prepare plugin-owned binding reads before admitting the exact host lineage. */
export async function resolveNativeSessionBindingWithAuthorityV2<TBinding>(
  params: NativeSessionBindingResolveOptions<TBinding> & {
    readBinding: (sessionId?: string) => Promise<TBinding | undefined>;
  },
) {
  return resolveNativeSessionBindingOwner(params, async (authority, previousSessionId) => {
    authority.assertCurrent();
    const current = await params.readBinding();
    const ownership =
      current ?? (previousSessionId ? await params.readBinding(previousSessionId) : undefined);
    return authority.withCurrent(() => {
      params.assertBinding?.(ownership);
      return current;
    });
  });
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
    ? await prepareNativeSessionGenerationAuthority({
        ...params,
        target: params.target,
        assertCurrent: assertAdmissionCurrent,
      })
    : undefined;
  const authority = combineNativeSessionBindingAuthority(
    params.authority,
    captured?.authority ?? createNativeSessionBindingAuthority([], assertAdmissionCurrent),
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
    generation: NativeSessionGenerationOperationsV2;
    reclaimStale?: boolean;
  },
): Promise<boolean> {
  params.assertCurrent?.();
  if (!params.target.sessionKey?.trim()) {
    return true;
  }
  const authority = await prepareNativeSessionGenerationAuthority(params);
  if (authority.state === "superseded") {
    return false;
  }
  return reclaimPreparedGeneration(params, authority);
}

/** Capture the host generation and predecessor together, then revalidate both after waits. */
export async function prepareNativeSessionGenerationAuthority(
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

type NativeSessionGenerationAuthority = Awaited<
  ReturnType<typeof prepareNativeSessionGenerationAuthority>
>;

/** Backend storage translates these decisions into its own record schema and native policy. */
export type NativeSessionGenerationOperationsV2 = {
  prepareReclaim: () => Promise<NativeSessionGenerationReclaimPlan>;
  adopt: (
    expectedPreviousSessionId: string,
    authority: NativeSessionBindingAuthority,
  ) => Promise<NativeSessionGenerationAdoptionResult>;
  reclaim: (
    expectedPreviousSessionId: string,
    authority: NativeSessionBindingAuthority,
  ) => Promise<boolean>;
};

async function reclaimPreparedGeneration(
  params: {
    generation: NativeSessionGenerationOperationsV2;
    reclaimStale?: boolean;
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
