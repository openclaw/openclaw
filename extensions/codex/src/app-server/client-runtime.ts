/** Client-scoped Codex auth and account observers. */
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { refreshCodexAppServerAuthTokens, type CodexAppServerAuthHandoff } from "./auth-bridge.js";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";
import type { CodexAppServerAuthRuntimeContext as ClientRuntimeContext } from "./auth-profile.js";
import {
  createThreadOwnerToken,
  forgetThreadOwnership,
  hasSiblingThreadWork,
  hasThreadOwnership,
  invalidateThreadOwnership,
  revertRetainedThreadSkillsCatalog,
  type RetainedLiveThread,
  type CodexEphemeralThreadPolicy,
  type CodexAppServerLiveThreadOwnership,
  type ThreadOwnershipState,
  type ThreadOwnerToken,
  type ThreadReleaseTransition,
} from "./client-thread-owner.js";
import {
  prepareCodexWorkspaceReferenceState,
  readCodexWorkspaceSessionMeta,
  type CodexClientWorkspaceState,
} from "./client-workspace-state.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type CodexServiceTier, type JsonObject } from "./protocol.js";
import { mergeCodexRateLimitsUpdate } from "./rate-limit-cache.js";
import { withTimeout } from "./timeout.js";

type ClientRuntime = ThreadOwnershipState &
  CodexClientWorkspaceState & {
    context: ClientRuntimeContext;
    authHandoff?: CodexAppServerAuthHandoff;
    evictionTimer?: ReturnType<typeof setTimeout>;
  };

/** Match Codex's native grace window without retaining inactive conversations indefinitely. */
const CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
/** Native-child parents are active ownership, so only otherwise-idle threads count against this cap. */
const CODEX_APP_SERVER_LIVE_THREAD_MAX_IDLE = 64;
/** Return a deterministic error before Codex cancels its ten-second external-auth request. */
const CODEX_EXTERNAL_AUTH_REFRESH_TIMEOUT_MS = 9_000;

const configuredClients = new WeakMap<CodexAppServerClient, ClientRuntime>();
const physicalThreadReleases = new WeakMap<
  CodexAppServerLiveThreadOwnership["release"],
  CodexAppServerLiveThreadOwnership["release"]
>();
const claimedThreadReleaseTokens = new WeakMap<
  CodexAppServerLiveThreadOwnership["release"],
  ThreadOwnerToken
>();

/** Only an initialized, still-open physical client can own retained native subscriptions. */
export function isCodexAppServerClientRuntimeLive(client: CodexAppServerClient): boolean {
  const runtime = configuredClients.get(client);
  return runtime !== undefined && !runtime.closed;
}

export function recordCodexAppServerAuthHandoff(
  client: CodexAppServerClient,
  handoff: CodexAppServerAuthHandoff | undefined,
): void {
  const runtime = configuredClients.get(client);
  if (runtime && !runtime.closed && handoff) {
    runtime.authHandoff = handoff;
  }
}

/** Reference history is only trusted while this native subscription stays warm. */
export function forgetCodexWorkspaceReferences(
  client: CodexAppServerClient,
  threadId: string,
): void {
  configuredClients.get(client)?.workspaceReferences.delete(threadId);
}

/** Record accepted input without clearing a compaction observed during turn/start. */
export function prepareCodexWorkspaceReferences(
  client: CodexAppServerClient,
  threadId: string,
  reference: string | undefined,
) {
  return prepareCodexWorkspaceReferenceState(configuredClients.get(client), threadId, reference);
}

/** Immutable declarations are data owned by this physical client, never retained executors. */
export async function readCodexClientSessionMeta(
  client: CodexAppServerClient,
  sessionsRoot: string,
  boundRolloutPath: string | undefined,
  threadId: string,
): Promise<JsonObject> {
  return readCodexWorkspaceSessionMeta(
    client,
    configuredClients.get(client),
    sessionsRoot,
    boundRolloutPath,
    threadId,
    CODEX_APP_SERVER_LIVE_THREAD_MAX_IDLE,
  );
}

/** Installs one auth-refresh handler and one rate-limit observer per physical client. */
export function ensureCodexAppServerClientRuntime(
  client: CodexAppServerClient,
  context: ClientRuntimeContext,
): void {
  const existing = configuredClients.get(client);
  if (existing) {
    if (existing.closed) {
      return;
    }
    // A live Codex process owns its original profile/store for its entire lifetime;
    // later leases may refresh config but must never redirect account-token refresh.
    existing.context = { ...existing.context, config: context.config };
    return;
  }
  const runtime: ClientRuntime = {
    context,
    closed: false,
    retainedThreads: new Map(),
    claimedThreads: new Map(),
    releasingThreads: new Map(),
    protectedThreads: new Map(),
    sessionMetadata: new Map(),
    workspaceReferences: new Map(),
  };
  configuredClients.set(client, runtime);
  client.addCloseHandler(() => {
    // Pending releases may settle after close; their continuations must never
    // resurrect subscriptions or eviction timers on a dead physical client.
    runtime.closed = true;
    if (runtime.evictionTimer) {
      clearTimeout(runtime.evictionTimer);
      runtime.evictionTimer = undefined;
    }
    for (const threadId of new Set([
      ...runtime.retainedThreads.keys(),
      ...runtime.claimedThreads.keys(),
      ...runtime.releasingThreads.keys(),
    ])) {
      invalidateThreadOwnership(runtime, threadId);
    }
    runtime.protectedThreads.clear();
    runtime.sessionMetadata.clear();
    runtime.workspaceReferences.clear();
  });
  client.addRequestHandler(async (request) => {
    if (request.method !== "account/chatgptAuthTokens/refresh") {
      return undefined;
    }
    if (runtime.context.authMode === "prepared-api-key") {
      throw new Error("ChatGPT token refresh is unavailable for prepared Codex API-key auth.");
    }
    if (!runtime.context.agentDir) {
      throw new Error("ChatGPT token refresh requires an OpenClaw-owned auth profile.");
    }
    const previousAccountId =
      isJsonObject(request.params) && typeof request.params.previousAccountId === "string"
        ? request.params.previousAccountId.trim() || undefined
        : undefined;
    const authHandoff = runtime.authHandoff;
    try {
      const tokens = await withTimeout(
        refreshCodexAppServerAuthTokens({
          agentDir: runtime.context.agentDir,
          authProfileId: runtime.context.authProfileId,
          ...(authHandoff ? { authHandoff } : {}),
          ...(previousAccountId ? { previousAccountId } : {}),
          ...(runtime.context.authProfileStore
            ? { authProfileStore: runtime.context.authProfileStore }
            : {}),
          config: runtime.context.config,
        }),
        CODEX_EXTERNAL_AUTH_REFRESH_TIMEOUT_MS,
        "Codex app-server ChatGPT token refresh timed out before its external-auth deadline. Retry the request; if it persists, sign in again with OpenClaw.",
      );
      if (previousAccountId && tokens.chatgptAccountId !== previousAccountId) {
        throw new Error(
          "ChatGPT workspace changed during Codex token refresh. Retry to start a client for the selected workspace.",
        );
      }
      if (runtime.closed) {
        throw new Error("Codex app-server client closed during ChatGPT token refresh.");
      }
      runtime.authHandoff = {
        accessFingerprint: fingerprintTokenAuthProfileCacheKey(tokens.accessToken),
        chatgptAccountId: tokens.chatgptAccountId,
      };
      return { ...tokens };
    } catch (error) {
      // Failed refresh leaves Codex holding its old account. Detach the cached
      // process before another acquisition; existing leases can finish safely.
      runtime.context.onAuthRefreshFailure?.();
      throw error;
    }
  });
  client.addNotificationHandler((notification) => {
    if (
      notification.method === "item/completed" &&
      isJsonObject(notification.params) &&
      isJsonObject(notification.params.item) &&
      notification.params.item.type === "contextCompaction" &&
      typeof notification.params.threadId === "string"
    ) {
      const threadId = notification.params.threadId;
      // Observe manual and automatic compaction even without an active turn projector.
      const previous = runtime.workspaceReferences.get(threadId);
      if (previous) {
        runtime.workspaceReferences.set(threadId, { ...previous, needsReintroduction: true });
      }
    }
    if (notification.method === "account/rateLimits/updated") {
      mergeCodexRateLimitsUpdate(client, notification.params);
      return;
    }
    if (
      notification.method === "thread/archived" ||
      notification.method === "thread/deleted" ||
      notification.method === "thread/closed"
    ) {
      const threadId = (notification.params as { threadId?: unknown } | undefined)?.threadId;
      if (typeof threadId === "string") {
        // Codex already removed server-side ownership; unsubscribing again can
        // race a replacement, so only discard this exact local ownership.
        invalidateThreadOwnership(runtime, threadId);
        runtime.sessionMetadata.delete(threadId);
        runtime.workspaceReferences.delete(threadId);
        scheduleRetainedThreadEviction(client, runtime);
      }
    }
  });
}

function scheduleRetainedThreadEviction(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): void {
  if (runtime.evictionTimer) {
    clearTimeout(runtime.evictionTimer);
    runtime.evictionTimer = undefined;
  }
  if (runtime.closed) {
    return;
  }
  let expiresAt = Number.POSITIVE_INFINITY;
  for (const [threadId, thread] of runtime.retainedThreads) {
    if (!runtime.protectedThreads.has(threadId)) {
      expiresAt = Math.min(expiresAt, thread.expiresAt);
    }
  }
  if (!Number.isFinite(expiresAt)) {
    return;
  }
  runtime.evictionTimer = setTimeout(
    () => {
      runtime.evictionTimer = undefined;
      void evictExpiredRetainedThreads(client, runtime).catch((error: unknown) => {
        // The subscription owner already chose safe shared-client retirement;
        // force-closing here would abort unrelated still-leased conversations.
        embeddedAgentLog.warn("codex retained thread expiry failed", {
          reason: formatErrorMessage(error),
        });
      });
    },
    Math.max(0, expiresAt - Date.now()),
  );
  runtime.evictionTimer.unref?.();
}

async function releaseRetainedThread(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
  threadId: string,
  assertCurrent?: () => void,
  withCurrent?: (write: () => void) => Promise<void>,
): Promise<boolean> {
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease.completion;
    assertCurrent?.();
    return false;
  }
  const retained = runtime.retainedThreads.get(threadId);
  if (!retained) {
    return false;
  }
  const olderThreadIds = new Set<string>();
  for (const candidateThreadId of runtime.retainedThreads.keys()) {
    if (candidateThreadId === threadId) {
      break;
    }
    olderThreadIds.add(candidateThreadId);
  }
  runtime.retainedThreads.delete(threadId);
  scheduleRetainedThreadEviction(client, runtime);
  // Keep release ownership addressable until unsubscribe settles. Unrelated
  // conversations must stay reusable while only this thread transitions.
  const transition: ThreadReleaseTransition = {
    retainedOwnerToken: retained.ownerToken,
    completion: Promise.resolve().then(() => {
      assertCurrent?.();
      return withCurrent
        ? retained.release(threadId, assertCurrent, withCurrent)
        : assertCurrent
          ? retained.release(threadId, assertCurrent)
          : retained.release(threadId);
    }),
  };
  runtime.releasingThreads.set(threadId, transition);
  try {
    await transition.completion;
    runtime.workspaceReferences.delete(threadId);
    retained.ownerToken?.invalidate();
    return true;
  } catch (error) {
    if (
      !runtime.closed &&
      !transition.invalidated &&
      runtime.releasingThreads.get(threadId) === transition &&
      !runtime.retainedThreads.has(threadId) &&
      !runtime.claimedThreads.has(threadId)
    ) {
      // A failed unsubscribe leaves the native subscription alive. Restore its
      // exact callback and LRU position; renewing TTL prevents a zero-delay retry spin.
      if (retained.ephemeralPolicy === undefined) {
        retained.expiresAt = Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS;
      }
      const newerThreads = [...runtime.retainedThreads.entries()].filter(
        ([candidateThreadId]) => !olderThreadIds.has(candidateThreadId),
      );
      for (const [candidateThreadId] of newerThreads) {
        runtime.retainedThreads.delete(candidateThreadId);
      }
      runtime.retainedThreads.set(threadId, retained);
      for (const [candidateThreadId, newerThread] of newerThreads) {
        runtime.retainedThreads.set(candidateThreadId, newerThread);
      }
    }
    throw error;
  } finally {
    if (runtime.releasingThreads.get(threadId) === transition) {
      runtime.releasingThreads.delete(threadId);
    }
    scheduleRetainedThreadEviction(client, runtime);
  }
}

async function evictExpiredRetainedThreads(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): Promise<void> {
  const now = Date.now();
  for (const [threadId, thread] of runtime.retainedThreads) {
    if (thread.expiresAt <= now && !runtime.protectedThreads.has(threadId)) {
      await releaseRetainedThread(client, runtime, threadId);
    }
  }
  scheduleRetainedThreadEviction(client, runtime);
}

async function evictExcessIdleThreads(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
): Promise<void> {
  const idleThreads = () =>
    [...runtime.retainedThreads].filter(
      ([threadId, thread]) =>
        thread.ephemeralPolicy === undefined && !runtime.protectedThreads.has(threadId),
    );
  let idleThreadIds = idleThreads();
  while (idleThreadIds.length > CODEX_APP_SERVER_LIVE_THREAD_MAX_IDLE) {
    await releaseRetainedThread(client, runtime, idleThreadIds[0]![0]);
    idleThreadIds = idleThreads();
  }
}

/** Retain separately owned Codex subscriptions; completing B must never cold-restart A. */
export async function retainCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  releaseThread?: (
    threadId: string,
    assertCurrent?: () => void,
    withCurrent?: (write: () => void) => Promise<void>,
  ) => Promise<void>,
  configFingerprint?: string,
  serviceTier?: CodexServiceTier | null,
  ephemeralPolicy?: CodexEphemeralThreadPolicy,
): Promise<boolean> {
  const runtime = configuredClients.get(client);
  if (!runtime || runtime.closed) {
    return false;
  }
  const claimed = runtime.claimedThreads.get(threadId);
  const ownerToken = releaseThread ? claimedThreadReleaseTokens.get(releaseThread) : undefined;
  if (claimed !== ownerToken || ownerToken?.invalidated) {
    // Only the active generation's branded ownership handle may republish it;
    // manual resume or another turn must never steal an in-flight subscription.
    return false;
  }
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease.completion;
    // The pending operation released this subscription. Publishing it again
    // without a subsequent thread/resume would invent native ownership.
    return false;
  }
  const previousOwner = runtime.retainedThreads.get(threadId)?.ownerToken;
  runtime.retainedThreads.delete(threadId);
  const retained: RetainedLiveThread = {
    ownerToken,
    configFingerprint,
    ephemeralPolicy,
    serviceTier,
    // Ephemeral history has no disk resume source. Preserve its existing client lifetime,
    // rather than subjecting it to the persistent registry's idle eviction.
    expiresAt:
      ephemeralPolicy === undefined
        ? Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS
        : Number.POSITIVE_INFINITY,
    release:
      (releaseThread ? (physicalThreadReleases.get(releaseThread) ?? releaseThread) : undefined) ??
      (async (releasedThreadId, assertCurrent, withCurrent) => {
        await unsubscribeCodexAppServerLiveThread(
          client,
          releasedThreadId,
          5_000,
          assertCurrent,
          withCurrent,
        );
      }),
  };
  runtime.retainedThreads.set(threadId, retained);
  if (previousOwner !== ownerToken) {
    previousOwner?.invalidate();
  }

  // Map insertion order is the LRU. Active turns are claimed out of this map,
  // and detached native-child parents are pinned until their final child settles.
  try {
    await evictExcessIdleThreads(client, runtime);
  } catch (error) {
    // Capacity eviction can retire the physical client. Never leave the new
    // thread published when its caller must instead release active ownership.
    if (runtime.retainedThreads.get(threadId) === retained) {
      runtime.retainedThreads.delete(threadId);
    }
    scheduleRetainedThreadEviction(client, runtime);
    embeddedAgentLog.warn("codex retained thread capacity eviction failed", {
      threadId,
      reason: formatErrorMessage(error),
    });
    return false;
  }
  if (runtime.closed) {
    return false;
  }
  // A turn owns its claimed subscription until its idle replacement actually
  // survives capacity eviction; a failed publish must remain fail-closed.
  if (claimed !== undefined && runtime.claimedThreads.get(threadId) === claimed) {
    runtime.claimedThreads.delete(threadId);
  }
  scheduleRetainedThreadEviction(client, runtime);
  return true;
}

/** Transfer one idle subscription to its next turn or compaction without touching sibling threads. */
export async function consumeCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  configFingerprint?: string,
): Promise<CodexAppServerLiveThreadOwnership | undefined> {
  const runtime = configuredClients.get(client);
  if (!runtime || runtime.closed) {
    return undefined;
  }
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    await pendingRelease.completion;
    return undefined;
  }
  const retained = runtime.retainedThreads.get(threadId);
  if (
    !retained ||
    (configFingerprint !== undefined && retained.configFingerprint !== configFingerprint)
  ) {
    return undefined;
  }
  return claimCodexAppServerThreadOwnership(client, runtime, threadId, retained);
}

/** Claims an auto-subscription; invalidation ends the handle after replacement or release. */
export async function claimCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  onInvalidated?: () => void,
): Promise<CodexAppServerLiveThreadOwnership | undefined> {
  const runtime = configuredClients.get(client);
  if (!runtime || runtime.closed || runtime.claimedThreads.has(threadId)) {
    return undefined;
  }
  const pendingRelease = runtime.releasingThreads.get(threadId);
  if (pendingRelease) {
    // A pending unsubscribe can invalidate the observed subscription; it must
    // never be resurrected after its physical connection acknowledges release.
    await pendingRelease.completion;
    return undefined;
  }
  const retained = runtime.retainedThreads.get(threadId) ?? {
    expiresAt: Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS,
    release: async (
      releasedThreadId: string,
      assertCurrent?: () => void,
      withCurrent?: (write: () => void) => Promise<void>,
    ) => {
      await unsubscribeCodexAppServerLiveThread(
        client,
        releasedThreadId,
        5_000,
        assertCurrent,
        withCurrent,
      );
    },
  };
  return claimCodexAppServerThreadOwnership(client, runtime, threadId, retained, onInvalidated);
}

function claimCodexAppServerThreadOwnership(
  client: CodexAppServerClient,
  runtime: ClientRuntime,
  threadId: string,
  retained: RetainedLiveThread,
  onInvalidated?: () => void,
): CodexAppServerLiveThreadOwnership {
  const previousClaim = runtime.claimedThreads.get(threadId);
  runtime.retainedThreads.delete(threadId);
  const claimed = createThreadOwnerToken(threadId, onInvalidated);
  runtime.claimedThreads.set(threadId, claimed);
  previousClaim?.invalidate();
  retained.ownerToken?.invalidate();
  scheduleRetainedThreadEviction(client, runtime);
  const assertCurrent = () => {
    if (claimed.invalidated || runtime.closed || runtime.claimedThreads.get(threadId) !== claimed) {
      throw new Error(`Codex thread subscription ownership changed: ${threadId}`);
    }
  };
  const release = async (
    releasedThreadId: string,
    assertReleaseCurrent?: () => void,
    withCurrent?: (write: () => void) => Promise<void>,
  ): Promise<void> => {
    // Codex subscriptions have no generation identifier. An obsolete owner
    // must be rejected before it can unsubscribe a replacement's live turn.
    if (releasedThreadId !== threadId || claimed.invalidated) {
      assertReleaseCurrent?.();
      return;
    }
    if (runtime.claimedThreads.get(threadId) !== claimed) {
      // A completed turn may release only the idle record it published. A new
      // claim, replacement retention, or eviction ends that release authority.
      if (runtime.retainedThreads.get(threadId)?.ownerToken === claimed) {
        await releaseRetainedThread(client, runtime, threadId, assertReleaseCurrent, withCurrent);
      } else {
        const pendingRelease = runtime.releasingThreads.get(threadId);
        if (pendingRelease?.retainedOwnerToken === claimed) {
          await pendingRelease.completion;
        }
        assertReleaseCurrent?.();
      }
      return;
    }
    const pendingRelease = runtime.releasingThreads.get(threadId);
    if (pendingRelease) {
      await pendingRelease.completion;
      return;
    }
    // Publish the transition before invoking the physical callback so a new
    // retain/claim cannot slip in while Codex acknowledges unsubscribe.
    const transition: ThreadReleaseTransition = {
      completion: Promise.resolve().then(async () => {
        if (runtime.closed || runtime.claimedThreads.get(threadId) !== claimed) {
          assertReleaseCurrent?.();
          return;
        }
        assertReleaseCurrent?.();
        await (withCurrent
          ? retained.release(releasedThreadId, assertReleaseCurrent, withCurrent)
          : assertReleaseCurrent
            ? retained.release(releasedThreadId, assertReleaseCurrent)
            : retained.release(releasedThreadId));
      }),
    };
    runtime.releasingThreads.set(threadId, transition);
    try {
      await transition.completion;
      if (runtime.claimedThreads.get(threadId) === claimed) {
        runtime.claimedThreads.delete(threadId);
        runtime.workspaceReferences.delete(threadId);
        claimed.invalidate();
      }
    } finally {
      if (runtime.releasingThreads.get(threadId) === transition) {
        runtime.releasingThreads.delete(threadId);
      }
    }
  };
  // Compaction and bound turns transfer this callback back into idle storage;
  // the successor must inherit its raw release, never the obsolete token guard.
  physicalThreadReleases.set(release, retained.release);
  claimedThreadReleaseTokens.set(release, claimed);
  return {
    assertCurrent,
    configFingerprint: retained.configFingerprint,
    ephemeralPolicy: retained.ephemeralPolicy,
    serviceTier: retained.serviceTier,
    release,
    forget: () => {
      if (forgetThreadOwnership(runtime, threadId, claimed)) {
        runtime.workspaceReferences.delete(threadId);
        scheduleRetainedThreadEviction(client, runtime);
      }
    },
  };
}

/** Standalone incognito compaction retains its separately owned subscription. */
export function revertCodexAppServerLiveThreadSkillsCatalog(
  client: CodexAppServerClient,
  threadId: string,
): void {
  const runtime = configuredClients.get(client);
  if (runtime && !runtime.closed) {
    revertRetainedThreadSkillsCatalog(runtime, threadId);
  }
}

/** Distinguish active claimed ownership from an already-evicted idle subscription. */
export function hasCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return hasThreadOwnership(configuredClients.get(client), threadId);
}

export function isCodexAppServerLiveThreadClaimed(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  const runtime = configuredClients.get(client);
  return runtime !== undefined && !runtime.closed && runtime.claimedThreads.has(threadId);
}

export function hasCodexAppServerSiblingThreadWork(
  client: CodexAppServerClient,
  threadId: string,
): boolean {
  return hasSiblingThreadWork(configuredClients.get(client), threadId);
}

/** Release the exact physical subscription and finish only its observed ownership generation. */
export async function unsubscribeCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  timeoutMs: number,
  assertCurrent?: () => void,
  withCurrent?: (write: () => void) => Promise<void>,
): Promise<void> {
  const runtime = configuredClients.get(client);
  const claimed = runtime?.claimedThreads.get(threadId);
  const retained = runtime?.retainedThreads.get(threadId);
  let transition = runtime?.releasingThreads.get(threadId);
  if (transition?.physicalRelease) {
    await transition.physicalRelease;
    assertCurrent?.();
    return;
  }
  const physicalRelease = Promise.resolve().then(async () => {
    if (
      (claimed !== undefined && runtime?.claimedThreads.get(threadId) !== claimed) ||
      (retained !== undefined && runtime?.retainedThreads.get(threadId) !== retained)
    ) {
      assertCurrent?.();
      return;
    }
    assertCurrent?.();
    await client.request(
      "thread/unsubscribe",
      { threadId },
      { timeoutMs, assertCurrent, ...(withCurrent ? { withCurrent } : {}) },
    );
    // Revalidate before successful release removes its own claim below.
    assertCurrent?.();
    runtime?.workspaceReferences.delete(threadId);
  });
  const ownsTransition = runtime !== undefined && transition === undefined;
  if (transition) {
    // Idle/claimed owners may invoke this helper from inside their own
    // transition; join its one RPC slot instead of joining ourselves.
    transition.physicalRelease = physicalRelease;
  } else if (runtime) {
    transition = { completion: physicalRelease, physicalRelease };
    runtime.releasingThreads.set(threadId, transition);
  }
  try {
    await physicalRelease;
    // Direct cleanup also owns idle entries; a successful RPC ends only the
    // retained or claimed generation observed before it began.
    if (retained !== undefined && runtime?.retainedThreads.get(threadId) === retained) {
      runtime.retainedThreads.delete(threadId);
      retained.ownerToken?.invalidate();
      scheduleRetainedThreadEviction(client, runtime);
    }
    if (claimed !== undefined && runtime?.claimedThreads.get(threadId) === claimed) {
      runtime.claimedThreads.delete(threadId);
      claimed.invalidate();
    }
  } finally {
    if (ownsTransition && runtime.releasingThreads.get(threadId) === transition) {
      runtime.releasingThreads.delete(threadId);
    }
  }
}

/** Reset/end owns the exact thread; failed generation retirement must never release its successor. */
export async function releaseCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
  assertCurrent?: () => void,
  withCurrent?: (write: () => void) => Promise<void>,
): Promise<boolean> {
  const runtime = configuredClients.get(client);
  return runtime
    ? await releaseRetainedThread(client, runtime, threadId, assertCurrent, withCurrent)
    : false;
}

/** Native child work pins its parent's subscription even after the foreground parent turn ends. */
export function protectCodexAppServerLiveThread(
  client: CodexAppServerClient,
  threadId: string,
): () => void {
  const runtime = configuredClients.get(client);
  if (!runtime || runtime.closed) {
    return () => undefined;
  }
  runtime.protectedThreads.set(threadId, (runtime.protectedThreads.get(threadId) ?? 0) + 1);
  scheduleRetainedThreadEviction(client, runtime);
  let protectedThread = true;
  return () => {
    if (!protectedThread) {
      return;
    }
    protectedThread = false;
    if (runtime.closed) {
      return;
    }
    const count = runtime.protectedThreads.get(threadId) ?? 0;
    if (count <= 1) {
      runtime.protectedThreads.delete(threadId);
      const retained = runtime.retainedThreads.get(threadId);
      if (retained) {
        // A detached child is live activity, not parent idleness. Its terminal
        // delivery starts the parent's normal warm-session retention window.
        if (retained.ephemeralPolicy === undefined) {
          retained.expiresAt = Date.now() + CODEX_APP_SERVER_LIVE_THREAD_IDLE_TIMEOUT_MS;
        }
        runtime.retainedThreads.delete(threadId);
        runtime.retainedThreads.set(threadId, retained);
      }
    } else {
      runtime.protectedThreads.set(threadId, count - 1);
    }
    scheduleRetainedThreadEviction(client, runtime);
    void evictExcessIdleThreads(client, runtime).catch((error: unknown) => {
      embeddedAgentLog.warn("codex retained thread unpin eviction failed", {
        threadId,
        reason: formatErrorMessage(error),
      });
    });
  };
}
