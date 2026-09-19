import { randomUUID } from "node:crypto";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

type DiscussionBindingGeneration = {
  accountId?: string;
  credentialFingerprint?: string;
  destinationIdentity: string;
  generation: string;
  pending?: {
    accountId: string;
    serverBaseUrl: string;
    workspaceId: string;
    sessionId: string;
    externalRef: string;
    credentialFingerprint: string;
  };
};

export type PendingDiscussionOpen = NonNullable<DiscussionBindingGeneration["pending"]> & {
  sessionKey: string;
  generation: string;
};

const GENERATION_STORE_OPTIONS = {
  namespace: "discussion-binding-generations",
  maxEntries: 10_000,
  // Pending records may be the only evidence of remotely committed channels.
  overflowPolicy: "reject-new",
} as const;

type GenerationStore = {
  store: PluginStateKeyedStore<DiscussionBindingGeneration>;
  native?: PluginStateSyncKeyedStore<DiscussionBindingGeneration>;
  tail: Promise<void>;
};
const storesByRuntime = new WeakMap<PluginRuntime, GenerationStore>();

function withGenerationStore<T>(
  runtime: PluginRuntime,
  run: (owner: GenerationStore) => Promise<T>,
): Promise<T> {
  let owner = storesByRuntime.get(runtime);
  if (!owner) {
    const store =
      runtime.state.openKeyedStore<DiscussionBindingGeneration>(GENERATION_STORE_OPTIONS);
    owner = {
      store,
      // The declared 2026.9.4 host floor predates comparison methods. Select its
      // uninterrupted native path before execution, never after a worker failure.
      // Remove it when the minimum host guarantees both comparison methods.
      ...(!store.observe || !store.compareAndApply
        ? {
            native:
              runtime.state.openSyncKeyedStore<DiscussionBindingGeneration>(
                GENERATION_STORE_OPTIONS,
              ),
          }
        : {}),
      tail: Promise.resolve(),
    };
    storesByRuntime.set(runtime, owner);
  }
  const currentOwner = owner;
  const current = owner.tail.then(() => run(currentOwner));
  owner.tail = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function mutateGeneration<T>(
  runtime: PluginRuntime,
  sessionKey: string,
  decide: (current: DiscussionBindingGeneration | undefined) => {
    value: DiscussionBindingGeneration | undefined;
    result: T;
  },
): Promise<T> {
  return withGenerationStore(runtime, async ({ store, native }) => {
    if (native) {
      const current = native.lookup(sessionKey);
      const next = decide(current);
      if (next.value !== current) {
        if (next.value) {
          native.register(sessionKey, next.value);
        } else {
          native.delete(sessionKey);
        }
      }
      return next.result;
    }
    const { observe, compareAndApply } = store;
    if (!observe || !compareAndApply) {
      throw new Error("ClickClack generation comparison capabilities changed");
    }
    let observed = await observe(sessionKey);
    for (;;) {
      const next = decide(observed.value);
      const outcome = await compareAndApply(
        sessionKey,
        observed.comparison,
        next.value === observed.value
          ? { operation: "update", action: "keep" }
          : next.value
            ? { operation: "update", action: "set", value: next.value }
            : { operation: "delete", action: "delete" },
      );
      if (outcome.status !== "conflict") {
        return next.result;
      }
      observed = outcome.current;
    }
  });
}

/** Reserves a generation so an interrupted channel create can be adopted on retry. */
export function reserveDiscussionBindingGeneration(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  accountId: string;
  credentialFingerprint: string;
  destinationIdentity: string;
  createGeneration?: () => string;
}): Promise<string> {
  let generation: string | undefined;
  return mutateGeneration(params.runtime, params.sessionKey, (existing) => {
    const existingAccountId = existing?.accountId ?? existing?.pending?.accountId;
    const existingCredentialFingerprint =
      existing?.credentialFingerprint ?? existing?.pending?.credentialFingerprint;
    if (
      existing?.destinationIdentity === params.destinationIdentity &&
      existingAccountId === params.accountId &&
      existingCredentialFingerprint === params.credentialFingerprint
    ) {
      return {
        value:
          existing.accountId && existing.credentialFingerprint
            ? existing
            : {
                ...existing,
                accountId: params.accountId,
                credentialFingerprint: params.credentialFingerprint,
              },
        result: existing.generation,
      };
    }
    generation ??= (params.createGeneration ?? randomUUID)();
    return {
      value: {
        accountId: params.accountId,
        credentialFingerprint: params.credentialFingerprint,
        destinationIdentity: params.destinationIdentity,
        generation,
      },
      result: generation,
    };
  });
}

/** Clears only the completed reservation; future opens must mint a new ownership ref. */
export function clearDiscussionBindingGeneration(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  expectedGeneration?: string;
}): Promise<void> {
  return mutateGeneration(params.runtime, params.sessionKey, (existing) => ({
    value:
      existing && params.expectedGeneration && existing.generation !== params.expectedGeneration
        ? existing
        : undefined,
    result: undefined,
  }));
}

/** Quarantines a destination before the first fallible channel create. */
export function recordPendingDiscussionOpen(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  generation: string;
  pending: NonNullable<DiscussionBindingGeneration["pending"]>;
}): Promise<void> {
  return mutateGeneration(params.runtime, params.sessionKey, (existing) => {
    if (!existing || existing.generation !== params.generation) {
      throw new Error("ClickClack discussion generation changed before channel creation");
    }
    if (
      existing.accountId !== params.pending.accountId ||
      existing.credentialFingerprint !== params.pending.credentialFingerprint
    ) {
      throw new Error("ClickClack discussion ownership changed before channel creation");
    }
    return { value: { ...existing, pending: params.pending }, result: undefined };
  });
}

export function listPendingDiscussionOpens(
  runtime: PluginRuntime,
): Promise<PendingDiscussionOpen[]> {
  return withGenerationStore(runtime, async ({ store }) =>
    (await store.entries()).flatMap((entry) =>
      entry.value.pending
        ? [{ sessionKey: entry.key, generation: entry.value.generation, ...entry.value.pending }]
        : [],
    ),
  );
}

/** Stops destination-wide quarantine after the exact remote channel is known. */
export function clearPendingDiscussionOpen(params: {
  runtime: PluginRuntime;
  sessionKey: string;
  expectedGeneration: string;
}): Promise<void> {
  return mutateGeneration(params.runtime, params.sessionKey, (existing) => {
    if (!existing || existing.generation !== params.expectedGeneration || !existing.pending) {
      return { value: existing, result: undefined };
    }
    return {
      value: {
        accountId: existing.accountId ?? existing.pending.accountId,
        credentialFingerprint:
          existing.credentialFingerprint ?? existing.pending.credentialFingerprint,
        destinationIdentity: existing.destinationIdentity,
        generation: existing.generation,
      },
      result: undefined,
    };
  });
}

export async function hasPendingDiscussionOpenForDestination(params: {
  runtime: PluginRuntime;
  serverBaseUrl: string;
  workspaceId: string;
}): Promise<boolean> {
  const serverBaseUrl = params.serverBaseUrl.replace(/\/+$/u, "");
  return (await listPendingDiscussionOpens(params.runtime)).some(
    (pending) =>
      pending.serverBaseUrl === serverBaseUrl && pending.workspaceId === params.workspaceId,
  );
}
