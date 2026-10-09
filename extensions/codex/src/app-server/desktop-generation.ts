/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { existsSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginServiceV2,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
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
type WatchFactory = (
  watchedPath: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => FSWatcher;
type DesktopGenerationRuntime = {
  platform: NodeJS.Platform;
  readFingerprint: () => Promise<string>;
  resolveWatchPaths: () => string[];
  pathExists: (watchedPath: string) => boolean;
  watchPath: WatchFactory;
};
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  watchers?: Set<FSWatcher>;
  watchHealthy?: boolean;
  rearmPending?: boolean;
  rearmDelayMs?: number;
  context?: OpenClawPluginServiceContextV2;
  runtime?: DesktopGenerationRuntime;
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
    pathExists: existsSync,
    watchPath: (watchedPath, options, listener) => watch(watchedPath, options, listener),
  },
): OpenClawPluginServiceV2 {
  return {
    apiVersion: 2,
    id: "codex-desktop-generation",
    async start(ctx) {
      if (runtime.platform !== "darwin") {
        return;
      }
      const current = state();
      current.context = ctx;
      current.runtime = { ...runtime };
      current.owner = createCodexDesktopGenerationOwner({
        signal: ctx.scheduler.signal,
        readFingerprint: runtime.readFingerprint,
        onGenerationChange: params.onGenerationChange,
        initialGeneration: current.lastGeneration,
      });
      armWatchers(current);
      void refreshGeneration(current, current.owner, current.owner.refresh());
    },
    async stop() {
      const current = state();
      const owner = current.owner;
      const scheduler = current.context?.scheduler;
      scheduler?.beginClose();
      current.lastGeneration = current.owner?.read() ?? current.lastGeneration;
      current.owner = undefined;
      current.context = undefined;
      current.runtime = undefined;
      current.watchHealthy = undefined;
      current.rearmDelayMs = undefined;
      current.rearmPending = false;
      closeWatchers(current);
      await Promise.all([scheduler?.stop(), owner?.waitForIdle()]);
    },
  };
}

function armWatchers(current: DesktopGenerationState): boolean {
  const owner = current.owner;
  const runtime = current.runtime;
  if (!owner || !runtime || current.watchers) {
    return false;
  }
  const watchers = new Set<FSWatcher>();
  current.watchers = watchers;
  const candidateNames = new Set<string>(
    resolveMacOSDesktopCodexAppPathCandidates("darwin").map((candidate) => candidate.appName),
  );
  let complete = true;
  for (const watchedPath of runtime.resolveWatchPaths()) {
    if (!runtime.pathExists(watchedPath)) {
      continue;
    }
    try {
      // Bundle roots need recursive invalidation: nested plugin bytes can change without
      // updating the app directory metadata that the settled fingerprint observes first.
      const watcher = runtime.watchPath(
        watchedPath,
        { recursive: watchedPath !== APPLICATIONS_PATH },
        (_eventType, filename) => {
          if (!isCurrentArm(current, owner, watchers)) {
            return;
          }
          if (
            watchedPath === APPLICATIONS_PATH &&
            filename &&
            !candidateNames.has(filename.toString().split(path.sep)[0] ?? "")
          ) {
            return;
          }
          owner.markDirty();
          scheduleRearm(current, owner);
        },
      );
      watchers.add(watcher);
      watcher.on("error", (error) => {
        if (!isCurrentArm(current, owner, watchers)) {
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
): boolean {
  return isCurrentOwner(current, owner) && current.watchers === watchers;
}

function scheduleRearm(current: DesktopGenerationState, owner: GenerationOwner): void {
  if (current.rearmPending && current.watchHealthy === false) {
    return;
  }
  const delayMs =
    current.watchHealthy === false
      ? (current.rearmDelayMs ?? REARM_INITIAL_DELAY_MS)
      : REARM_INITIAL_DELAY_MS;
  if (current.watchHealthy === false) {
    current.rearmDelayMs = Math.min(delayMs * 2, REARM_MAX_DELAY_MS);
  }
  current.rearmPending = true;
  current.context?.scheduler.schedule({
    id: "watcher-rearm",
    delayMs,
    run: async () => {
      current.rearmPending = false;
      if (!isCurrentOwner(current, owner)) {
        return;
      }
      const wasUnhealthy = current.watchHealthy === false;
      closeWatchers(current);
      if (!armWatchers(current) || wasUnhealthy) {
        owner.markDirty();
      }
      await refreshGeneration(current, owner, owner.wait());
    },
  });
}

function refreshGeneration(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): Promise<void> {
  return refresh
    .then(() => {
      if (isCurrentOwner(current, owner) && current.watchHealthy) {
        current.context?.serviceHealth?.clearFailure();
      }
    })
    .catch((error: unknown) => {
      if (!isCurrentOwner(current, owner)) {
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

function isCurrentOwner(current: DesktopGenerationState, owner: GenerationOwner): boolean {
  return current.owner === owner && !current.context?.scheduler.signal.aborted;
}
