import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  closeCodexStartupClientBestEffort,
  CodexAppServerUnsafeSubscriptionError,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import {
  consumeCodexAppServerLiveThread,
  isCodexAppServerClientRuntimeLive,
  isCodexAppServerLiveThreadClaimed,
  isCodexAppServerLiveThreadProtected,
  releaseCodexAppServerLiveThread,
  readCodexLiveThreadEphemeralPolicy,
} from "./client-runtime.js";
import { createCodexEphemeralThreadPolicy } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import {
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
} from "./inference-routing.js";
import { attestCodexThreadToolSurface } from "./plugin-thread-attestation.js";
import {
  buildCodexPluginAppsConfigPatchFromPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { isJsonObject, type CodexThread } from "./protocol.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { retainSharedCodexAppServerClientByInstanceId } from "./shared-client.js";
import {
  fingerprintCodexThreadConfig,
  fingerprintRestrictedThreadConfig,
} from "./thread-fingerprints.js";
import { CodexThreadBindingConflictError } from "./thread-lifecycle-errors.js";
import {
  buildCodexThreadRequestConfig,
  prepareCodexThreadFinalConfigPatch,
  type CodexThreadRequestContext,
} from "./thread-lifecycle-preflight.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadFinalConfigPatchResult,
} from "./thread-lifecycle-types.js";
import {
  isSameCodexAppServerThreadOwner,
  retainCodexAppServerBindingSubscription,
} from "./thread-ownership.js";
import {
  assertAdoptedCodexThreadResumeAllowed,
  CodexIncognitoPolicyChangeError,
  refreshCodexThreadInstructions,
} from "./thread-policy.js";

type CodexWarmThreadReuseParams = CodexThreadRequestContext & {
  params: CodexStartOrResumeThreadParams;
  binding: CodexAppServerThreadBinding;
  clientId?: string;
  requireRestrictedThreadConfigFingerprint?: boolean;
  buildLoadedPluginThreadConfig: (
    binding: CodexAppServerThreadBinding,
  ) => Promise<CodexPluginThreadConfig | undefined>;
};

type CodexWarmThreadReuseResult =
  | {
      kind: "ready";
      binding: CodexAppServerThreadLifecycleBinding;
      cleanupOnFailure?: () => Promise<void>;
    }
  | { kind: "rotate" }
  | { kind: "resume"; prebuiltFinalConfigPatch?: CodexThreadFinalConfigPatchResult };

type CodexLiveThreadReleaseParams = {
  client: CodexAppServerClient;
  abandonClient?: () => Promise<void>;
  lifecycleTiming: CodexThreadLifecycleTimingTracker;
  threadId: string;
  assertCurrent?: () => void;
  withCurrent?: (write: () => void) => Promise<void>;
  signal?: AbortSignal;
};

/** Preserves the caller's abort reason across thread ownership transitions. */
export function throwIfCodexThreadLifecycleAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw codexThreadLifecycleAbortError(signal);
  }
}

// Converts an aborted lifecycle signal into the error its caller observes.
function codexThreadLifecycleAbortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error(
    typeof reason === "string" && reason.length > 0
      ? reason
      : "codex app-server thread lifecycle aborted",
  );
  error.name = "AbortError";
  return error;
}

/** Releases consumed subscription ownership or retires an unsafe client. */
export async function releaseCodexConsumedLiveThread(
  options: CodexLiveThreadReleaseParams,
): Promise<void> {
  const released = await options.lifecycleTiming.measure("retained-thread-unsubscribe", () =>
    unsubscribeCodexThreadBestEffort(options.client, {
      threadId: options.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
      assertCurrent: options.assertCurrent,
      withCurrent: options.withCurrent,
    }),
  );
  if (released) {
    return;
  }
  return await abandonCodexLiveThreadRelease(options);
}

async function abandonCodexLiveThreadRelease(
  options: CodexLiveThreadReleaseParams,
  cause?: unknown,
): Promise<never> {
  options.assertCurrent?.();
  await (options.abandonClient ?? (() => closeCodexStartupClientBestEffort(options.client)))();
  throw new CodexAppServerUnsafeSubscriptionError(
    `Codex retained thread subscription could not be released: ${options.threadId}`,
    cause !== undefined ? { cause } : undefined,
  );
}

/** Releases through the retained owner, preserving its guarded callback and rollback. */
async function releaseCodexRetainedLiveThread(
  options: CodexLiveThreadReleaseParams,
): Promise<boolean> {
  try {
    return await options.lifecycleTiming.measure("retained-thread-unsubscribe", () =>
      releaseCodexAppServerLiveThread(
        options.client,
        options.threadId,
        options.assertCurrent,
        options.withCurrent,
      ),
    );
  } catch (error) {
    // An owner callback may already have retired the client; do not close it twice.
    if (error instanceof CodexAppServerUnsafeSubscriptionError) {
      throw error;
    }
    return await abandonCodexLiveThreadRelease(options, error);
  }
}

/** Release follows the physical owner across connection rotation, never a copied thread id. */
export async function releaseCodexBoundLiveThread(
  options: CodexLiveThreadReleaseParams & {
    clientId?: string;
    ownerClientId?: string;
    /** Runs synchronously when `signal` ends a wait for the previous owner's exit. */
    onExitWaitCancelled?: () => void;
  },
): Promise<boolean> {
  const exitWaitAbortError = (signal: AbortSignal) => {
    // Abort dispatch calls this synchronously, before any rejection handler runs.
    options.onExitWaitCancelled?.();
    return codexThreadLifecycleAbortError(signal);
  };
  const changedClient = options.ownerClientId && options.ownerClientId !== options.clientId;
  const previous = changedClient
    ? await retainSharedCodexAppServerClientByInstanceId(options.ownerClientId!, {
        signal: options.signal,
        createAbortError: exitWaitAbortError,
      })
    : undefined;
  if (changedClient && !previous) {
    return false;
  }
  const client = previous?.client ?? options.client;
  let threadClosed: Promise<void> | undefined;
  let stopWatching: (() => void) | undefined;
  if (previous) {
    // Unsubscribe acknowledges detachment, not shutdown. Observe this physical
    // owner's stopped runtime before release can trigger its idle unload.
    threadClosed = new Promise<void>((resolve) => {
      stopWatching = client.addNotificationHandler((notification) => {
        if (
          notification.method === "thread/closed" &&
          isJsonObject(notification.params) &&
          notification.params.threadId === options.threadId
        ) {
          resolve();
        }
      });
    });
  }
  try {
    if (
      isCodexAppServerLiveThreadClaimed(client, options.threadId) ||
      isCodexAppServerLiveThreadProtected(client, options.threadId)
    ) {
      throw new Error(`Codex thread ${options.threadId} is claimed by active work; stop it first.`);
    }
    return await releaseCodexRetainedLiveThread({
      ...options,
      client,
      abandonClient: previous ? undefined : options.abandonClient,
      assertCurrent: options.assertCurrent
        ? () => {
            options.assertCurrent?.();
            const closed = previous?.client.getCloseError();
            if (closed) {
              throw closed;
            }
          }
        : undefined,
    });
  } finally {
    try {
      // Rejection must free the lane so the claimed run can still be stopped.
      const retiredExit = previous?.release(
        !isCodexAppServerLiveThreadClaimed(client, options.threadId) &&
          !isCodexAppServerLiveThreadProtected(client, options.threadId),
      );
      if (retiredExit) {
        // A sibling lease can retain the retired process indefinitely. Exact
        // thread closure confirms runtime shutdown; native resume independently
        // enforces its exclusive persistence writer lock, including shutdown errors.
        await options.lifecycleTiming.measure("retired-thread-runtime-release", () =>
          racePromiseWithAbortSignal(
            threadClosed ? Promise.race([retiredExit, threadClosed]) : retiredExit,
            options.signal,
            exitWaitAbortError,
          ),
        );
      }
    } finally {
      stopWatching?.();
    }
  }
}

/** Reuses one safely owned, fully matching subscription on its original client. */
export async function tryReuseCodexLiveThread(
  options: CodexWarmThreadReuseParams,
): Promise<CodexWarmThreadReuseResult> {
  const {
    params,
    binding,
    bindingIdentity,
    clientId,
    dynamicToolsFingerprint,
    environmentSelectionFingerprint,
    lifecycleTiming,
    ringZeroActive,
    restrictedToolSurface,
    startModelSelection,
    throwIfAborted,
  } = options;
  const incognito = isIncognitoSessionKey(params.params.sessionKey);
  const creationPolicy = incognito
    ? readCodexLiveThreadEphemeralPolicy(params.client, binding.threadId)
    : undefined;
  if (creationPolicy && options.admittedNativeThread?.status?.type !== "notLoaded") {
    const effectivePolicy = createCodexEphemeralThreadPolicy(
      params,
      options.effectiveConfig.config,
    );
    if (
      creationPolicy.autoCompactTokenLimit !== effectivePolicy.autoCompactTokenLimit ||
      creationPolicy.autoCompactTokenLimitScope !== effectivePolicy.autoCompactTokenLimitScope
    ) {
      throw new CodexIncognitoPolicyChangeError("compaction settings");
    }
  }

  // These native-owned ephemeral lifetimes do not enter ordinary
  // configuration ownership. Keep their existing live-only continuation path.
  if (incognito && (binding.preserveNativeModel || binding.connectionScope === "supervision")) {
    if (options.admittedNativeThread?.status?.type === "notLoaded") {
      return { kind: "rotate" };
    }
    if (
      binding.clientId === clientId &&
      binding.clientId &&
      ((await options.buildLoadedPluginThreadConfig(binding))?.fingerprint ??
        binding.pluginAppsFingerprint) === binding.pluginAppsFingerprint
    ) {
      // Native adoption cannot establish immutable creation settings from current defaults.
      if (!creationPolicy && params.appServer.serviceTier === "ultrafast") {
        throw new CodexIncognitoPolicyChangeError("compaction settings");
      }
      await prepareCodexThreadFinalConfigPatch(params, options.nativeModelInputTools, binding);
      throwIfAborted();
      params.assertCurrent?.();
      return { kind: "ready", binding: { ...binding, lifecycle: { action: "resumed" } } };
    }
    return { kind: "rotate" };
  }

  if (!binding.clientId || binding.clientId !== clientId || (ringZeroActive && !incognito)) {
    return { kind: "resume" };
  }

  const retainedThread = await consumeCodexAppServerLiveThread(params.client, binding.threadId);
  if (!retainedThread) {
    return { kind: "resume" };
  }
  const assertWarmOwner = () => {
    throwIfAborted();
    // Startup attaches router abort after this lifecycle call. A closed client's
    // inventory failure must not be treated as revocation of the durable binding.
    if (!isCodexAppServerClientRuntimeLive(params.client)) {
      throw params.client.getCloseError() ?? new Error("codex app-server client is closed");
    }
    try {
      // Notifications can revoke this exact claim while its physical client stays
      // healthy. Both subscription and host authority must survive policy awaits.
      retainedThread.assertCurrent();
      params.params.hostCapabilities.assertActive();
      params.assertCurrent?.();
    } catch (cause) {
      throw new AgentHarnessPreflightError(
        "Codex warm thread ownership changed before this turn could run. No turn was sent; reconnect before continuing, or start a new conversation if the original thread was closed.",
        { cause },
      );
    }
  };
  let ownershipTransferred = false;
  let preserveSubscription = false;
  let nativeThread: CodexThread | undefined;
  const cleanup = async (
    retainSubscription: boolean,
    ownership = retainedThread,
  ): Promise<void> => {
    let failure: { cause: unknown } | undefined;
    try {
      let pendingRetention: Promise<boolean> | undefined;
      if (retainSubscription) {
        try {
          const currentBinding = await params.bindingStore.readAsync(bindingIdentity);
          const retain = () => {
            assertWarmOwner();
            if (isSameCodexAppServerThreadOwner(currentBinding, binding)) {
              pendingRetention = retainCodexAppServerBindingSubscription(
                params.client,
                binding.threadId,
                ownership,
              );
            }
          };
          if (params.authority) {
            await params.authority.withCurrent(retain);
          } else {
            retain();
          }
        } catch {
          // Rejected admission never transfers the consumed claim back to idle storage.
        }
      }
      if (pendingRetention) {
        if (!(await pendingRetention)) {
          failure = {
            cause: new Error("Codex live thread ownership could not be returned to its session"),
          };
        }
      } else {
        // Keep the claim's generation fence across policy awaits and binding conflicts.
        await retainedThread.release(binding.threadId);
      }
    } catch (cause) {
      failure = { cause };
    }
    if (failure) {
      await abandonCodexLiveThreadRelease(
        {
          client: params.client,
          abandonClient: params.abandonClient,
          lifecycleTiming,
          threadId: binding.threadId,
        },
        failure.cause,
      );
    }
  };
  try {
    assertWarmOwner();
    if (binding.preserveNativeModel || binding.connectionScope === "supervision") {
      try {
        nativeThread =
          options.admittedNativeThread ??
          (await assertAdoptedCodexThreadResumeAllowed(
            params,
            binding.threadId,
            options,
            assertWarmOwner,
          ));
      } catch (error) {
        // This read-only preflight cannot change native configuration. Direct-input
        // refusals and failed reads preserve it too, but revocation or cancellation cannot.
        assertWarmOwner();
        const currentBinding = await params.bindingStore.readAsync(bindingIdentity);
        assertWarmOwner();
        preserveSubscription = isSameCodexAppServerThreadOwner(currentBinding, binding);
        throw error;
      }
      assertWarmOwner();
      if (nativeThread.status?.type === "notLoaded") {
        preserveSubscription = true;
        return { kind: "resume" };
      }
    }
    const pluginThreadConfig = await options.buildLoadedPluginThreadConfig(binding);
    assertWarmOwner();
    if (pluginThreadConfig && pluginThreadConfig.fingerprint !== binding.pluginAppsFingerprint) {
      // Rotation has not changed native policy. Keep the idle owner available
      // if background work prevents the caller from releasing this subscription.
      preserveSubscription = true;
      return { kind: "rotate" };
    }
    // Engine identity, projection epoch, and policy were checked by the owner
    // before this call; compatible bootstrap threads must keep their session.

    const prebuiltFinalConfigPatch = await prepareCodexThreadFinalConfigPatch(
      params,
      options.nativeModelInputTools,
      binding,
    );
    const pluginAppsConfigPatch =
      pluginThreadConfig?.configPatch ??
      (params.pluginThreadConfig?.enabled && binding.pluginAppPolicyContext
        ? buildCodexPluginAppsConfigPatchFromPolicyContext(binding.pluginAppPolicyContext)
        : undefined);
    const resumeAuthProfileId =
      binding.connectionScope === "supervision"
        ? undefined
        : (params.params.authProfileId ?? binding.authProfileId);
    const resumeConfig = buildCodexThreadRequestConfig(
      params,
      options,
      pluginAppsConfigPatch,
      prebuiltFinalConfigPatch.configPatch,
    );
    const resumeParams = await lifecycleTiming.measure("warm-thread-resume-params", () =>
      options.buildResumeParams(binding, resumeAuthProfileId, resumeConfig),
    );
    options.assertInferenceConfig(
      resumeParams.config,
      resumeParams.modelProvider ??
        (binding.preserveNativeModel
          ? nativeThread?.modelProvider?.trim() || binding.modelProvider
          : undefined),
    );
    const ephemeralPolicy = retainedThread.ephemeralPolicy;
    if (
      incognito &&
      (!ephemeralPolicy ||
        ephemeralPolicy.developerInstructions !== params.developerInstructions ||
        getCodexInferenceThread(params.client, binding.threadId) !== params.inferenceRoute ||
        [...(params.inferenceProviderRoutes?.keys() ?? [])].some(
          (provider) =>
            !getCodexInferenceThreadQualification(params.client, binding.threadId)?.hasProvider(
              provider,
            ),
        ))
    ) {
      preserveSubscription = true;
      throw new CodexIncognitoPolicyChangeError();
    }
    if (
      options.requireRestrictedThreadConfigFingerprint &&
      (Boolean(binding.nativeToolPolicyRestricted) !== restrictedToolSurface ||
        params.nativeCodeModeEnabled !== false ||
        binding.restrictedThreadConfigFingerprint !==
          fingerprintRestrictedThreadConfig(
            resumeParams,
            resumeAuthProfileId,
            dynamicToolsFingerprint,
            params.params,
            options.hostSystemAgentActive,
            binding,
            params,
          ))
    ) {
      // Refusal must leave the original ephemeral or protected owner available.
      preserveSubscription = true;
      if (incognito) {
        throw new CodexIncognitoPolicyChangeError("creation policy");
      }
      return { kind: "rotate" };
    }
    const liveThreadConfigFingerprint = incognito
      ? retainedThread.configFingerprint
      : fingerprintCodexThreadConfig(
          resumeParams,
          resumeAuthProfileId,
          dynamicToolsFingerprint,
          binding,
          params,
        );
    if (!incognito && retainedThread.configFingerprint !== liveThreadConfigFingerprint) {
      // Return the same owner first: cold-resume preparation must observe native teardown
      // before releasing it, otherwise a loaded resume can silently ignore new policy.
      preserveSubscription = true;
      return { kind: "resume", prebuiltFinalConfigPatch };
    }
    try {
      await attestCodexThreadToolSurface({
        client: params.client,
        threadId: binding.threadId,
        appIds: pluginThreadConfig?.provisionalAppIds ?? [],
        signal: params.signal,
        threadConfig: resumeParams.config,
        restrictedToolSurface,
        lifecycleTiming,
        assertCurrent: assertWarmOwner,
        withCurrent: params.authority?.withCurrent,
      });
    } catch (error) {
      // Admission can reject before its consumer runs; keep warm-owner guidance.
      assertWarmOwner();
      throw error;
    }
    assertWarmOwner();
    if (
      ephemeralPolicy &&
      ephemeralPolicy.refreshableInstructions !== params.refreshableInstructions
    ) {
      try {
        await refreshCodexThreadInstructions({
          client: params.client,
          threadId: binding.threadId,
          refreshableInstructions: params.refreshableInstructions,
          timeoutMs: params.appServer.requestTimeoutMs,
          signal: params.signal,
          assertCurrent: assertWarmOwner,
          withCurrent: params.authority?.withCurrent,
        });
      } catch (error) {
        // The ephemeral conversation survives a failed instruction handoff; the retained
        // record still names the old instructions, so the next turn delivers it again.
        preserveSubscription = true;
        throw error;
      }
    }
    const nativeHookRelayGeneration =
      prebuiltFinalConfigPatch.nativeHookRelayGeneration ?? binding.nativeHookRelayGeneration;
    // Older App Servers omit model metadata; newer ones report native changes between turns.
    const model = binding.preserveNativeModel
      ? nativeThread?.model?.trim() || binding.model
      : startModelSelection.model;
    const modelProvider = binding.preserveNativeModel
      ? nativeThread?.modelProvider?.trim() || binding.modelProvider
      : binding.modelProvider;
    const bindingPatch = {
      cwd: params.cwd,
      model,
      modelProvider,
      nativeHookRelayGeneration,
      environmentSelectionFingerprint,
    };
    // Validate ownership even when relay generation is unchanged; reset may
    // have replaced the persisted binding since it was first read. Model and
    // cwd are sticky turn settings, so future turns and /btw need current facts.
    const committed =
      incognito ||
      (await lifecycleTiming.measure("warm-thread-write-binding", () =>
        params.bindingStore.mutate(
          bindingIdentity,
          {
            kind: "patch",
            threadId: binding.threadId,
            // Environment selection is sticky turn/start state, like cwd/model;
            // recording its new value must not recreate the approval-bearing thread.
            patch: bindingPatch,
          },
          assertWarmOwner,
          params.authority,
        ),
      ));
    if (!committed) {
      throw new CodexThreadBindingConflictError(binding.threadId, "committing a reused thread");
    }
    assertWarmOwner();
    lifecycleTiming.mark("thread-ready");
    lifecycleTiming.logSummary({
      runId: params.params.runId,
      sessionId: params.params.sessionId,
      sessionKey: params.params.sessionKey,
      threadId: binding.threadId,
      action: "resumed",
    });
    const liveThreadEphemeralPolicy = ephemeralPolicy && {
      ...ephemeralPolicy,
      refreshableInstructions: params.refreshableInstructions,
    };
    ownershipTransferred = true;
    return {
      kind: "ready",
      // Publication or enclosing lease settlement can fail after this transfer.
      // Protected work keeps a current warm owner, not a deferred unsubscribe claim.
      cleanupOnFailure: () =>
        cleanup(isCodexAppServerLiveThreadProtected(params.client, binding.threadId), {
          ...retainedThread,
          configFingerprint: liveThreadConfigFingerprint,
          ephemeralPolicy: liveThreadEphemeralPolicy,
        }),
      binding: {
        ...binding,
        ...(!incognito ? bindingPatch : {}),
        liveThreadConfigFingerprint,
        liveThreadEphemeralPolicy,
        liveThreadOwnership: retainedThread,
        ...(!incognito && retainedThread.serviceTier && resumeParams.serviceTier === undefined
          ? { clearInheritedServiceTier: true }
          : {}),
        lifecycle: { action: "resumed" },
      },
    };
  } finally {
    if (!ownershipTransferred) {
      await cleanup(preserveSubscription);
    }
  }
}
