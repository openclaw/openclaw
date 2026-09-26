/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import path from "node:path";
import { root } from "@openclaw/fs-safe/root";
import { watch, type WatchOptions, type WatchSubscription } from "@openclaw/fs-safe/watch";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveFsObservationIntervalMs,
  resolveFsObservationMode,
} from "openclaw/plugin-sdk/file-access-runtime";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  createCodexDesktopGenerationOwner,
  type CodexDesktopGeneration,
} from "./desktop-generation-owner.js";

const APPLICATIONS_PATH = "/Applications";
const REARM_INITIAL_DELAY_MS = 100;
const REARM_MAX_DELAY_MS = 30_000;

type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type WatchFactory = (watchedPath: string, options: WatchOptions) => Promise<WatchSubscription>;
type DesktopGenerationRuntime = {
  platform: NodeJS.Platform;
  readFingerprint: () => Promise<string>;
  resolveWatchPaths: () => string[];
  watchPath: WatchFactory;
};
type WatchArm = {
  pending: Promise<void>;
  subscriptions: Set<WatchSubscription>;
};
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  arm?: WatchArm;
  retirement?: Promise<void>;
  watchHealthy?: boolean;
  rearmTimer?: NodeJS.Timeout;
  rearmRequested?: boolean;
  rearmDelayMs?: number;
  context?: OpenClawPluginServiceContext;
  resolveWatchPaths?: () => string[];
  watchPath?: WatchFactory;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  return state().owner?.wait() ?? Promise.resolve(undefined);
}

export function isCodexDesktopGenerationCurrent(
  generation: CodexDesktopGeneration | undefined,
): boolean {
  return state().owner?.isCurrent(generation) ?? false;
}

export function createCodexDesktopGenerationService(
  params: {
    onGenerationChange: (generation: CodexDesktopGeneration) => void;
  },
  runtime: DesktopGenerationRuntime = {
    platform: process.platform,
    readFingerprint: readMacOSDesktopGenerationFingerprint,
    resolveWatchPaths: resolveMacOSDesktopGenerationWatchPaths,
    watchPath: async (watchedPath, options) => watch(await root(watchedPath), options),
  },
): OpenClawPluginService {
  return {
    id: "codex-desktop-generation",
    async start(ctx) {
      if (runtime.platform !== "darwin") {
        return;
      }
      const current = state();
      current.context = ctx;
      current.resolveWatchPaths = runtime.resolveWatchPaths;
      current.watchPath = runtime.watchPath;
      current.owner = createCodexDesktopGenerationOwner({
        readFingerprint: runtime.readFingerprint,
        onGenerationChange: params.onGenerationChange,
        initialGeneration: current.lastGeneration,
      });
      armWatchers(current);
      refreshGeneration(current, current.owner, current.owner.refresh());
    },
    async stop() {
      const current = state();
      current.lastGeneration = current.owner?.read() ?? current.lastGeneration;
      current.owner?.stop();
      current.owner = undefined;
      current.resolveWatchPaths = undefined;
      current.watchPath = undefined;
      current.watchHealthy = undefined;
      current.rearmDelayMs = undefined;
      current.rearmRequested = undefined;
      if (current.rearmTimer) {
        clearTimeout(current.rearmTimer);
        current.rearmTimer = undefined;
      }
      try {
        await closeWatchers(current);
      } finally {
        current.context = undefined;
        current.retirement = undefined;
      }
    },
  };
}

function armWatchers(current: DesktopGenerationState): void {
  const owner = current.owner;
  const watchPath = current.watchPath;
  if (!owner || current.arm || !watchPath) {
    return;
  }
  const arm: WatchArm = { pending: Promise.resolve(), subscriptions: new Set() };
  current.arm = arm;
  const isCurrent = () => current.owner === owner && current.arm === arm;
  let failed = false;
  const fail = (error: unknown) => {
    if (!isCurrent()) {
      return;
    }
    failed = true;
    reportWatcherFailure(current, owner, error);
    scheduleRefresh(current, owner);
  };
  const bundles = [...new Set(current.resolveWatchPaths?.() ?? [])].filter(
    (watchedPath) => watchedPath !== APPLICATIONS_PATH,
  );
  // Selection already follows .app root links. Admit those roots separately;
  // the stable parent observes link retargeting and missing/replaced bundles.
  const paths = [APPLICATIONS_PATH, ...bundles];
  arm.pending = joinWatchWork(
    paths.map(async (watchedPath) => {
      const parent = watchedPath === APPLICATIONS_PATH;
      let admitted = false;
      let subscription: WatchSubscription;
      try {
        const mode = resolveFsObservationMode();
        subscription = await watchPath(watchedPath, {
          scopes: parent
            ? bundles.map((bundle) => ({
                path: path.relative(APPLICATIONS_PATH, bundle),
                kind: "entry" as const,
              }))
            : // Use the API's maximum depth for the formerly unbounded recursive owner.
              [{ path: "", kind: "tree", depth: 128 }],
          mode,
          ...(mode === "poll" ? { intervalMs: resolveFsObservationIntervalMs() } : {}),
          onInvalidate(invalidation) {
            if (!isCurrent() || invalidation.changes?.length === 0) {
              return;
            }
            if (
              parent &&
              admitted &&
              (!invalidation.changes ||
                invalidation.changes.some((change) => change.type === "structural"))
            ) {
              current.rearmRequested = true;
            }
            owner.markDirty();
            scheduleRefresh(current, owner);
          },
          onHealth(health) {
            if (health.state === "unavailable") {
              fail(health.failure?.error ?? new Error("Codex desktop observation unavailable"));
            }
          },
        });
      } catch (error) {
        const code = extractErrorCode(error);
        // The parent entry subscription observes installation of an absent bundle.
        if (!parent && (code === "not-found" || code === "ENOENT" || code === "ENOTDIR")) {
          return;
        }
        fail(error);
        return;
      }
      // A late admission is closed before its active-generation ready await.
      void subscription.ready.catch(() => {});
      if (!isCurrent()) {
        await subscription.close();
        return;
      }
      arm.subscriptions.add(subscription);
      try {
        await subscription.ready;
        admitted = true;
      } catch (error) {
        fail(error);
      }
    }),
  ).then(() => {
    if (isCurrent() && !failed) {
      current.watchHealthy = true;
      current.rearmDelayMs = REARM_INITIAL_DELAY_MS;
      refreshGeneration(current, owner, owner.wait());
    }
  });
  // A late admission can fail retirement; retain the rejected promise for stop to join.
  void arm.pending.catch((error: unknown) => {
    current.context?.serviceHealth?.reportFailure(error);
    current.context?.logger.warn(`codex desktop generation watcher close failed: ${String(error)}`);
  });
}

function reportWatcherFailure(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  error: unknown,
): void {
  if (current.watchHealthy === false) {
    return;
  }
  current.watchHealthy = false;
  owner.markDirty();
  current.context?.serviceHealth?.reportFailure(error);
  current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
}

function scheduleRefresh(current: DesktopGenerationState, owner: GenerationOwner): void {
  if (current.rearmTimer) {
    if (current.watchHealthy === false) {
      return;
    }
    clearTimeout(current.rearmTimer);
  }
  const delayMs =
    current.watchHealthy === false
      ? (current.rearmDelayMs ?? REARM_INITIAL_DELAY_MS)
      : REARM_INITIAL_DELAY_MS;
  if (current.watchHealthy === false) {
    current.rearmDelayMs = Math.min(delayMs * 2, REARM_MAX_DELAY_MS);
  }
  current.rearmTimer = setTimeout(() => {
    current.rearmTimer = undefined;
    if (current.owner !== owner) {
      return;
    }
    void (async () => {
      if (current.watchHealthy === false || current.rearmRequested) {
        current.rearmRequested = false;
        await closeWatchers(current);
        if (current.owner !== owner) {
          return;
        }
        armWatchers(current);
        owner.markDirty();
      }
      refreshGeneration(current, owner, owner.wait());
    })().catch((error: unknown) => {
      if (current.owner === owner) {
        reportWatcherFailure(current, owner, error);
      }
    });
  }, delayMs);
  current.rearmTimer.unref();
}

function refreshGeneration(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): void {
  void refresh
    .then(() => {
      if (current.owner === owner && current.watchHealthy) {
        current.context?.serviceHealth?.clearFailure();
      }
    })
    .catch((error: unknown) => {
      if (current.owner !== owner) {
        return;
      }
      current.context?.serviceHealth?.reportFailure(error);
      current.context?.logger.warn(`codex desktop generation refresh failed: ${String(error)}`);
    });
}

function closeWatchers(current: DesktopGenerationState): Promise<void> {
  const arm = current.arm;
  current.arm = undefined;
  if (arm) {
    const retirement = joinWatchWork([
      ...[...arm.subscriptions].map((subscription) => subscription.close()),
      arm.pending,
    ]);
    current.retirement = joinWatchWork([current.retirement ?? Promise.resolve(), retirement]);
  }
  return current.retirement ?? Promise.resolve();
}

async function joinWatchWork(work: Promise<unknown>[]): Promise<void> {
  const failures = (await Promise.allSettled(work))
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Codex desktop observation retirement failed");
  }
}
