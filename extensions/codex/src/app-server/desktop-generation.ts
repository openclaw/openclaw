/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import {
  resolveSelectedMacOSDesktopCodexAppPathCandidates,
  type MacOSDesktopCodexAppPathCandidate,
} from "./desktop-app-paths.js";
import {
  readMacOSDesktopGenerationFingerprint,
  resolveMacOSDesktopGenerationWatchPaths,
} from "./desktop-generation-fingerprint.js";
import {
  createCodexDesktopGenerationOwner,
  type CodexDesktopGeneration,
} from "./desktop-generation-owner.js";
import { resolveCodexManagedDesktopRoot } from "./managed-desktop-installation.js";

const APPLICATIONS_PATH = "/Applications";
const REARM_INITIAL_DELAY_MS = 100;
const REARM_MAX_DELAY_MS = 30_000;

type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type WatchFactory = (
  watchedPath: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;
type DesktopGenerationRuntime = {
  platform: NodeJS.Platform;
  readFingerprint: (candidates: readonly MacOSDesktopCodexAppPathCandidate[]) => Promise<string>;
  resolveCandidates: () => Promise<readonly MacOSDesktopCodexAppPathCandidate[]>;
  resolveWatchPaths: (candidates: readonly MacOSDesktopCodexAppPathCandidate[]) => string[];
  pathExists: (watchedPath: string) => boolean;
  watchPath: WatchFactory;
};
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  watchers?: Set<FSWatcher>;
  watchHealthy?: boolean;
  armEpoch?: number;
  rearmTimer?: NodeJS.Timeout;
  rearmDelayMs?: number;
  context?: OpenClawPluginServiceContext;
  candidates?: readonly MacOSDesktopCodexAppPathCandidate[];
  resolveCandidates?: DesktopGenerationRuntime["resolveCandidates"];
  selectionRefresh?: Promise<void>;
  readFingerprint?: () => Promise<string>;
  resolveWatchPaths?: () => string[];
  pathExists?: (watchedPath: string) => boolean;
  watchPath?: WatchFactory;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export async function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  const current = state();
  const owner = current.owner;
  if (!owner) {
    return undefined;
  }
  // Every unpinned acquisition observes foreign commits. Only a changed selection
  // invalidates the existing owner; unchanged rows do not rehash bundles or settle.
  const refresh = (current.selectionRefresh ?? Promise.resolve()).then(async () => {
    const candidates = await current.resolveCandidates?.();
    if (current.owner !== owner || !candidates) {
      return;
    }
    if (selectionKey(candidates) !== selectionKey(current.candidates ?? [])) {
      current.candidates = candidates;
      owner.markDirty();
      scheduleRearm(current, owner);
    }
  });
  current.selectionRefresh = refresh.catch(() => {});
  await refresh;
  return current.owner === owner ? owner.wait() : undefined;
}

/** Pins executable candidates to the acquired owner generation, without another DB read. */
export function readCodexDesktopGenerationCandidates(
  generation: CodexDesktopGeneration | undefined,
): readonly MacOSDesktopCodexAppPathCandidate[] | undefined {
  const current = state();
  return current.owner?.isCurrent(generation) ? current.candidates : undefined;
}

function selectionKey(candidates: readonly MacOSDesktopCodexAppPathCandidate[]): string {
  return JSON.stringify(candidates.map((candidate) => candidate.appServerCommandPath));
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
    resolveCandidates: () => resolveSelectedMacOSDesktopCodexAppPathCandidates("darwin"),
    resolveWatchPaths: resolveMacOSDesktopGenerationWatchPaths,
    pathExists: existsSync,
    watchPath: (watchedPath, options, listener) => watch(watchedPath, options, listener),
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
      const startEpoch = (current.armEpoch ?? 0) + 1;
      current.armEpoch = startEpoch;
      const candidates = await runtime.resolveCandidates();
      if (current.context !== ctx || current.armEpoch !== startEpoch) {
        return;
      }
      current.candidates = candidates;
      current.resolveCandidates = runtime.resolveCandidates;
      current.readFingerprint = () => runtime.readFingerprint(current.candidates ?? []);
      current.resolveWatchPaths = () => runtime.resolveWatchPaths(current.candidates ?? []);
      current.pathExists = runtime.pathExists;
      current.watchPath = runtime.watchPath;
      current.owner = createCodexDesktopGenerationOwner({
        readFingerprint: current.readFingerprint,
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
      current.armEpoch = (current.armEpoch ?? 0) + 1;
      current.context = undefined;
      current.candidates = undefined;
      current.resolveCandidates = undefined;
      current.selectionRefresh = undefined;
      current.readFingerprint = undefined;
      current.resolveWatchPaths = undefined;
      current.pathExists = undefined;
      current.watchPath = undefined;
      current.watchHealthy = undefined;
      current.rearmDelayMs = undefined;
      if (current.rearmTimer) {
        clearTimeout(current.rearmTimer);
        current.rearmTimer = undefined;
      }
      closeWatchers(current);
    },
  };
}

function armWatchers(current: DesktopGenerationState): boolean {
  const owner = current.owner;
  if (!owner || current.watchers) {
    return false;
  }
  const armEpoch = (current.armEpoch ?? 0) + 1;
  current.armEpoch = armEpoch;
  const watchers = new Set<FSWatcher>();
  current.watchers = watchers;
  const candidates = current.candidates ?? [];
  const candidateNames = new Set<string>(candidates.map((candidate) => candidate.appName));
  const managedRoot = resolveCodexManagedDesktopRoot();
  const managedBundlePaths = candidates
    .map((candidate) => candidate.appBundlePath)
    .filter((bundlePath) => isPathWithin(managedRoot, bundlePath));
  let complete = true;
  for (const watchedPath of current.resolveWatchPaths?.() ?? []) {
    if (!current.pathExists?.(watchedPath)) {
      continue;
    }
    try {
      // Bundle roots need recursive invalidation: nested plugin bytes can change without
      // updating the app directory metadata that the settled fingerprint observes first.
      const watcher = current.watchPath?.(
        watchedPath,
        { recursive: watchedPath !== APPLICATIONS_PATH },
        (_eventType, filename) => {
          if (!isCurrentArm(current, owner, watchers, armEpoch)) {
            return;
          }
          if (
            watchedPath === APPLICATIONS_PATH &&
            filename &&
            !candidateNames.has(filename.toString().split(path.sep)[0] ?? "")
          ) {
            return;
          }
          if (
            filename &&
            watchedPath !== APPLICATIONS_PATH &&
            isPathWithin(watchedPath, managedRoot)
          ) {
            const changedPath = path.resolve(watchedPath, filename.toString());
            // Downloads and unselected versions are not a generation change. Only
            // the selected bundle or root creation/replacement matters.
            if (
              !isPathWithin(changedPath, managedRoot) &&
              !managedBundlePaths.some((bundlePath) => isPathWithin(bundlePath, changedPath))
            ) {
              return;
            }
          }
          owner.markDirty();
          scheduleRearm(current, owner);
        },
      );
      if (!watcher) {
        complete = false;
        reportWatcherFailure(current, owner, new Error(`Could not watch ${watchedPath}`));
        scheduleRearm(current, owner);
        continue;
      }
      watchers.add(watcher);
      watcher.on("error", (error) => {
        if (!isCurrentArm(current, owner, watchers, armEpoch)) {
          return;
        }
        reportWatcherFailure(current, owner, error);
        scheduleRearm(current, owner);
      });
    } catch (error) {
      complete = false;
      reportWatcherFailure(current, owner, error);
      scheduleRearm(current, owner);
    }
  }
  current.watchHealthy = complete;
  if (complete) {
    current.rearmDelayMs = REARM_INITIAL_DELAY_MS;
  }
  return complete;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
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

function isCurrentArm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  watchers: Set<FSWatcher>,
  armEpoch: number,
): boolean {
  return current.owner === owner && current.watchers === watchers && current.armEpoch === armEpoch;
}

function scheduleRearm(current: DesktopGenerationState, owner: GenerationOwner): void {
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
    const wasUnhealthy = current.watchHealthy === false;
    closeWatchers(current);
    if (!armWatchers(current) || wasUnhealthy) {
      owner.markDirty();
    }
    refreshGeneration(current, owner, owner.wait());
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

function closeWatchers(current: DesktopGenerationState): void {
  const watchers = current.watchers;
  current.watchers = undefined;
  for (const watcher of watchers ?? []) {
    watcher.close();
  }
}
