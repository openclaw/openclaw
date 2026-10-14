/**
 * Per-profile Browser lifecycle actor.
 *
 * Starts and destructive transitions share one settled serial tail. Ordinary
 * Tab/action work stays concurrent; transitions cancel it and wait for settlement.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { getChromeMcpModule } from "./chrome-mcp.runtime.js";
import type { RunningChrome } from "./chrome.js";
import { stopOpenClawChrome, stopOwnedOpenClawChrome } from "./chrome.js";
import type { ResolvedBrowserConfig, ResolvedBrowserProfile } from "./config.js";
import { BrowserProfileUnavailableError } from "./errors.js";
import type { ExtensionRelayResource } from "./extension-relay/relay-access.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { getLoadedPwAiModule } from "./pw-ai-module.js";
import type { PlaywrightConnectionRetirement } from "./pw-session.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

type ProfileLifecycleTerminal = "deleted" | "config-removed";

type ProfileLifecycleActor = {
  controller: AbortController;
  /** Settled-only tail: failed starts/transitions never poison later work. */
  tail: Promise<void>;
  starts: Map<string, Promise<void>>;
  leases: Set<Promise<void>>;
  handles: Set<RunningChrome>;
  cleanupChromeMcp: Set<string>;
  cleanupPlaywright: Map<string, PlaywrightConnectionRetirement>;
  cleanupRelays: Set<ExtensionRelayResource>;
  terminal: ProfileLifecycleTerminal | null;
  transitionReason: string | null;
  blockedReason: string | null;
};

type ProfileTransitionOptions = {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  reason: string;
  terminal?: ProfileLifecycleTerminal;
  closeRelay?: boolean;
  captureProfileResources?: boolean;
  /** Bridge runtimes must not retire process-global adapters shared by another runtime. */
  closeSharedAdapters?: boolean;
  managedChrome?: "stop" | "release-profile-data";
  exposeReason?: boolean;
  afterCleanup?: () => Promise<void>;
  rollbackTerminalOnFailure?: boolean;
};

type ProfileTransitionResult = {
  stopped: boolean;
};

type ProfileLeaseContext = {
  signal: AbortSignal;
};

const profileLeaseStorage = new AsyncLocalStorage<Map<ProfileRuntimeState, ProfileLeaseContext>>();
const profileLifecycles = new WeakMap<ProfileRuntimeState, ProfileLifecycleActor>();
const stoppingBrowserRuntimes = new WeakSet<BrowserServerState>();

function createProfileLifecycleActor(): ProfileLifecycleActor {
  return {
    controller: new AbortController(),
    tail: Promise.resolve(),
    starts: new Map(),
    leases: new Set(),
    handles: new Set(),
    cleanupChromeMcp: new Set(),
    cleanupPlaywright: new Map(),
    cleanupRelays: new Set(),
    terminal: null,
    transitionReason: null,
    blockedReason: null,
  };
}

/** Internal lifecycle state stays outside the public Browser runtime API shape. */
export function getProfileLifecycle(runtime: ProfileRuntimeState): ProfileLifecycleActor {
  let actor = profileLifecycles.get(runtime);
  if (!actor) {
    actor = createProfileLifecycleActor();
    profileLifecycles.set(runtime, actor);
  }
  return actor;
}

export function isBrowserRuntimeRunning(state: BrowserServerState): boolean {
  return !stoppingBrowserRuntimes.has(state);
}

export function markBrowserRuntimeStopping(state: BrowserServerState): void {
  stoppingBrowserRuntimes.add(state);
}

/** Internal control flow: an owned unhealthy process needs a destructive fence. */
export class ProfileRestartRequiredError extends Error {
  constructor() {
    super("Managed browser restart requires a lifecycle transition.");
    this.name = "ProfileRestartRequiredError";
  }
}

export function isProfileRestartRequiredError(err: unknown): boolean {
  return err instanceof ProfileRestartRequiredError;
}

export function isWithinProfileOperationLease(runtime: ProfileRuntimeState): boolean {
  return profileLeaseStorage.getStore()?.has(runtime) === true;
}

function lifecycleError(profileName: string, detail: string): BrowserProfileUnavailableError {
  return new BrowserProfileUnavailableError(
    `Browser profile "${profileName}" lifecycle changed while work was pending (${detail}).`,
  );
}

function toLifecycleError(value: unknown, message: string): Error {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

function assertRuntimeAdmission(state: BrowserServerState): void {
  if (!isBrowserRuntimeRunning(state)) {
    throw new BrowserProfileUnavailableError("Browser runtime is stopping.");
  }
}

function assertProfileCurrent(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  allowBlocked?: boolean;
}): void {
  assertRuntimeAdmission(params.state);
  const actor = getProfileLifecycle(params.runtime);
  if (actor.terminal) {
    throw lifecycleError(params.runtime.profile.name, actor.terminal);
  }
  if (actor.blockedReason && !params.allowBlocked) {
    throw lifecycleError(params.runtime.profile.name, actor.blockedReason);
  }
}

/** Allow explicit lifecycle operations to repair a failed cleanup. */
export function assertProfileLifecycleContext(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
}): void {
  assertProfileCurrent({ ...params, allowBlocked: true });
}

function combineSignals(lifecycleSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  if (!callerSignal || callerSignal === lifecycleSignal) {
    return lifecycleSignal;
  }
  return AbortSignal.any([lifecycleSignal, callerSignal]);
}

/** Observe shared lifecycle work without transferring cancellation ownership. */
export function waitForProfileOperation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }
  signal.throwIfAborted();
  let onAbort!: () => void;
  const waiting = new Promise<T>((resolve, reject) => {
    onAbort = () => reject(toLifecycleError(signal.reason, "Browser operation aborted."));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject);
  });
  return waiting.finally(() => signal.removeEventListener("abort", onAbort));
}

function createLease(actor: ProfileLifecycleActor): () => void {
  const { promise: settled, resolve: release } = createDeferred<void>();
  actor.leases.add(settled);
  return () => {
    actor.leases.delete(settled);
    release();
  };
}

/** Return the current runtime object; terminal tombstones stay until exact cleanup removes them. */
export function getOrCreateProfileRuntime(
  state: BrowserServerState,
  profile: ResolvedBrowserProfile,
): ProfileRuntimeState {
  assertRuntimeAdmission(state);
  const current = state.profiles.get(profile.name);
  if (current) {
    getProfileLifecycle(current);
    return current;
  }
  const created: ProfileRuntimeState = { profile, running: null, lastTargetId: null };
  getProfileLifecycle(created);
  state.profiles.set(profile.name, created);
  return created;
}

/** Track an exact managed-process handle before it can be adopted or retired. */
export function registerProfileHandle(
  runtime: ProfileRuntimeState,
  running: RunningChrome,
): boolean {
  getProfileLifecycle(runtime).handles.add(running);
  running.proc.on("exit", () => releaseProfileHandle(runtime, running));
  if (running.proc.exitCode != null || running.proc.signalCode != null) {
    releaseProfileHandle(runtime, running);
    return false;
  }
  return true;
}

/** Release only the exact managed-process handle that completed cleanup. */
export function releaseProfileHandle(runtime: ProfileRuntimeState, running: RunningChrome): void {
  getProfileLifecycle(runtime).handles.delete(running);
  if (runtime.running === running) {
    runtime.running = null;
  }
}

/** Check the captured lifecycle signal at resource effect boundaries. */
export function isProfileOperationCurrent(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  signal: AbortSignal;
}): boolean {
  const actor = getProfileLifecycle(params.runtime);
  return (
    isBrowserRuntimeRunning(params.state) &&
    !actor.terminal &&
    !actor.blockedReason &&
    !params.signal.aborted
  );
}

/**
 * Run ordinary profile work under a concurrent settlement lease.
 *
 * Passing the current lifecycle signal denotes nested work already covered by
 * an outer lease; this avoids self-deadlock while preserving cancellation.
 */
export async function withProfileOperationLease<T>(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  signal?: AbortSignal;
  /** Shared producers belong to the lifecycle, never to their first caller. */
  ownership?: "caller" | "lifecycle";
  run: (signal: AbortSignal) => Promise<T>;
  commit?: (result: T) => void | Promise<void>;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const actor = getProfileLifecycle(params.runtime);
  const inherited = profileLeaseStorage.getStore();
  const parent = params.ownership === "lifecycle" ? undefined : inherited?.get(params.runtime);
  if (parent) {
    const signal = combineSignals(parent.signal, params.signal);
    signal.throwIfAborted();
    assertProfileCurrent(params);
    const result = await params.run(signal);
    signal.throwIfAborted();
    assertProfileCurrent(params);
    await params.commit?.(result);
    return result;
  }

  const lifecycleSignal = actor.controller.signal;
  assertProfileCurrent(params);
  await waitForProfileOperation(actor.tail, params.signal);
  const signal =
    params.ownership === "lifecycle"
      ? lifecycleSignal
      : combineSignals(lifecycleSignal, params.signal);
  signal.throwIfAborted();
  const release = createLease(actor);
  try {
    const leases = new Map(inherited);
    leases.set(params.runtime, { signal });
    const result = await profileLeaseStorage.run(leases, async () => await params.run(signal));
    signal.throwIfAborted();
    assertProfileCurrent(params);
    // This assertion is the operation's linearization point. Once admitted,
    // an async persistent commit keeps its lease until complete; a later
    // reset/delete/stop drains behind it instead of partially cancelling it.
    await params.commit?.(result);
    return result;
  } finally {
    release();
  }
}

/** Queue one lifecycle-owned start, coalescing callers with the same start key. */
export function enqueueProfileStart(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  key: string;
  signal?: AbortSignal;
  run: (signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  assertProfileCurrent(params);
  params.signal?.throwIfAborted();
  const actor = getProfileLifecycle(params.runtime);
  const existing = actor.starts.get(params.key);
  if (existing) {
    return waitForProfileOperation(existing, params.signal);
  }

  const signal = actor.controller.signal;
  const promise = actor.tail.then(async () => {
    assertProfileCurrent(params);
    signal.throwIfAborted();
    const owned = new Map(profileLeaseStorage.getStore());
    owned.set(params.runtime, { signal });
    await profileLeaseStorage.run(owned, async () => await params.run(signal));
    assertProfileCurrent(params);
    signal.throwIfAborted();
  });
  actor.starts.set(params.key, promise);
  const settleStart = () => {
    if (actor.starts.get(params.key) === promise) {
      actor.starts.delete(params.key);
    }
  };
  actor.tail = promise.then(settleStart, settleStart);
  return waitForProfileOperation(promise, params.signal);
}

function capturePlaywrightRetirement(
  actor: ProfileLifecycleActor,
  cdpUrl: string,
): PlaywrightConnectionRetirement | null {
  const retained = actor.cleanupPlaywright.get(cdpUrl);
  if (retained) {
    retained.refresh?.();
    return retained;
  }
  const retirement =
    getLoadedPwAiModule()?.retirePlaywrightBrowserConnectionExact({ cdpUrl }) ?? null;
  if (retirement?.retired) {
    actor.cleanupPlaywright.set(cdpUrl, retirement);
  }
  return retirement;
}

async function cleanupProfileResources(params: {
  state: BrowserServerState;
  runtime: ProfileRuntimeState;
  eagerMcpClose: Promise<boolean> | null;
  hadPendingWork: boolean;
  managedChrome?: {
    mode: NonNullable<ProfileTransitionOptions["managedChrome"]>;
    profile: ResolvedBrowserProfile;
    resolved: ResolvedBrowserConfig;
  };
}): Promise<ProfileTransitionResult> {
  const { runtime } = params;
  let stopped = params.hadPendingWork;
  if (params.eagerMcpClose) {
    stopped = (await params.eagerMcpClose) || stopped;
  }
  let firstError: Error | undefined;
  const actor = getProfileLifecycle(runtime);
  // `running` remains part of the public runtime shape. Include handles
  // installed by older callers that predate lifecycle registration.
  const managedHandles = new Set(actor.handles);
  if (runtime.running) {
    managedHandles.add(runtime.running);
  }
  for (const running of managedHandles) {
    try {
      await stopOpenClawChrome(running);
      releaseProfileHandle(runtime, running);
      stopped = true;
    } catch (err) {
      firstError ??= toLifecycleError(err, "Managed browser cleanup failed.");
    }
  }

  if (actor.cleanupChromeMcp.size > 0) {
    try {
      const chromeMcp = await getChromeMcpModule.peek();
      for (const profileName of actor.cleanupChromeMcp) {
        stopped = (await chromeMcp?.closeChromeMcpSession(profileName)) || stopped;
        actor.cleanupChromeMcp.delete(profileName);
      }
    } catch (err) {
      firstError ??= toLifecycleError(err, "Chrome MCP cleanup failed.");
    }
  }

  stopped = actor.cleanupPlaywright.size > 0 || stopped;
  for (const [cdpUrl, retirement] of actor.cleanupPlaywright) {
    try {
      await retirement.close();
      actor.cleanupPlaywright.delete(cdpUrl);
    } catch (err) {
      firstError ??= toLifecycleError(err, "Playwright cleanup failed.");
    }
  }
  for (const relay of actor.cleanupRelays) {
    try {
      await relay.close();
      actor.cleanupRelays.delete(relay);
      if (params.state.extensionRelays?.get(runtime.profile.name) === relay) {
        params.state.extensionRelays.delete(runtime.profile.name);
        const tokens = { ...params.state.resolved.extensionRelayInternalTokens };
        delete tokens[runtime.profile.name];
        params.state.resolved = { ...params.state.resolved, extensionRelayInternalTokens: tokens };
      }
    } catch (err) {
      firstError ??= toLifecycleError(err, "Browser relay cleanup failed.");
    }
  }
  if (firstError) {
    throw firstError;
  }
  if (params.managedChrome) {
    const { mode, profile, resolved } = params.managedChrome;
    const result = await stopOwnedOpenClawChrome(resolved, profile);
    if (mode === "release-profile-data" && result.status === "unverified") {
      throw new BrowserProfileUnavailableError(
        `Cannot release browser profile "${profile.name}" data: ${result.reason}. Close that browser and retry.`,
      );
    }
    stopped = result.status === "stopped" || stopped;
  }
  return { stopped };
}

/**
 * Synchronously cancel current work, eagerly begin owned adapter
 * teardown, then serialize exact-handle cleanup behind older starts and leases.
 */
export function beginProfileTransition(
  params: ProfileTransitionOptions,
): Promise<ProfileTransitionResult> {
  const actor = getProfileLifecycle(params.runtime);
  const ownerProfile = params.runtime.profile;
  const managedChrome =
    params.managedChrome &&
    ownerProfile.driver === "openclaw" &&
    ownerProfile.cdpIsLoopback &&
    !ownerProfile.attachOnly
      ? { mode: params.managedChrome, profile: ownerProfile, resolved: params.state.resolved }
      : undefined;
  const hadPendingWork = actor.starts.size > 0 || actor.leases.size > 0 || actor.handles.size > 0;
  const reason = lifecycleError(params.runtime.profile.name, params.reason);

  params.runtime.externalBrowserMode = undefined;
  actor.controller.abort(reason);
  actor.controller = new AbortController();
  actor.starts.clear();
  if (params.terminal) {
    actor.terminal = params.terminal;
  }
  // Every successor owns the visible transition slot, including clearing it.
  actor.transitionReason = params.exposeReason ? params.reason : null;
  const closeSharedAdapters = params.closeSharedAdapters !== false;
  const usesChromeMcp = getBrowserProfileCapabilities(ownerProfile).usesChromeMcp;
  if (closeSharedAdapters && usesChromeMcp) {
    actor.cleanupChromeMcp.add(ownerProfile.name);
  }
  const shouldClosePlaywright =
    closeSharedAdapters && params.captureProfileResources !== false && !usesChromeMcp;
  const eagerPlaywrightRetirement = shouldClosePlaywright
    ? capturePlaywrightRetirement(actor, ownerProfile.cdpUrl)
    : null;
  const captureRelay = () => {
    const relay =
      params.closeRelay && params.state.extensionRelays?.get(params.runtime.profile.name);
    if (relay) {
      actor.cleanupRelays.add(relay);
    }
  };
  captureRelay();

  // Start closing MCP before waiting for a start, lease, or older transition.
  const eagerMcpClose =
    closeSharedAdapters && usesChromeMcp
      ? (getChromeMcpModule
          .peek()
          ?.then(({ closeChromeMcpSession }) => closeChromeMcpSession(ownerProfile.name))
          .catch(() => false) ?? null)
      : null;
  let cleanupCompleted = false;
  const transition = actor.tail
    .then(async () => {
      await Promise.allSettled(actor.leases);
      if (shouldClosePlaywright && hadPendingWork) {
        capturePlaywrightRetirement(actor, ownerProfile.cdpUrl);
      }
      captureRelay();
      const result = await cleanupProfileResources({
        state: params.state,
        runtime: params.runtime,
        eagerMcpClose,
        hadPendingWork: hadPendingWork || Boolean(eagerPlaywrightRetirement?.retired),
        managedChrome,
      });
      cleanupCompleted = true;
      await params.afterCleanup?.();
      actor.blockedReason = null;
      return result;
    })
    .catch((err: unknown) => {
      if (cleanupCompleted) {
        if (params.rollbackTerminalOnFailure) {
          actor.terminal = null;
        }
        actor.blockedReason = null;
      } else {
        actor.blockedReason = `${params.reason} cleanup failed`;
      }
      throw err;
    });
  const settleTransition = () => {
    actor.transitionReason = null;
  };
  actor.tail = transition.then(settleTransition, settleTransition);
  return transition;
}
