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
  context?: OpenClawPluginServiceContextV2;
  runtime?: DesktopGenerationRuntime;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  const current = state();
  const owner = current.owner;
  return (
    (current.watchHealthy === false ? owner?.refresh() : owner?.wait()) ??
    Promise.resolve(undefined)
  );
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
      void refreshGeneration(current, current.owner.refresh());
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
      closeWatchers(current);
      await Promise.all([scheduler?.stop(), owner?.waitForIdle()]);
    },
  };
}

function armWatchers(current: DesktopGenerationState, retryOnFailure = true): boolean {
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
        reportWatcherFailure(current, owner, error);
        scheduleRearm(current, owner);
      });
    } catch (error) {
      complete = false;
      reportWatcherFailure(current, owner, error);
    }
  }
  current.watchHealthy = complete;
  if (!complete && retryOnFailure) {
    scheduleRearm(current, owner, false);
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

function scheduleRearm(
  current: DesktopGenerationState,
  owner: GenerationOwner,
  retryOnFailure = true,
): void {
  current.context?.scheduler.schedule({
    id: "watcher-rearm",
    delayMs: REARM_INITIAL_DELAY_MS,
    run: async () => {
      const wasUnhealthy = current.watchHealthy === false;
      closeWatchers(current);
      if (!armWatchers(current, retryOnFailure) || wasUnhealthy) {
        owner.markDirty();
      }
      await refreshGeneration(current, owner.wait());
    },
  });
}

function refreshGeneration(
  current: DesktopGenerationState,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): Promise<void> {
  return refresh
    .then(() => {
      if (!current.context?.scheduler.signal.aborted && current.watchHealthy) {
        current.context?.serviceHealth?.clearFailure();
      }
    })
    .catch((error: unknown) => {
      if (!current.context || current.context.scheduler.signal.aborted) {
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
