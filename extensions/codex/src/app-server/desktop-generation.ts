/** Lifecycle-owned generation for managed macOS Codex desktop artifacts. */
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import type {
  OpenClawPluginServiceV2,
  OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { defineCodexBuildState } from "../build-state.js";
import { resolveMacOSDesktopCodexAppPathCandidates } from "./desktop-app-paths.js";
import { readMacOSDesktopGenerationFingerprint } from "./desktop-generation-fingerprint.js";
import {
  createCodexDesktopGenerationOwner,
  type CodexDesktopGeneration,
} from "./desktop-generation-owner.js";

const APPLICATIONS_PATH = "/Applications";
type GenerationOwner = ReturnType<typeof createCodexDesktopGenerationOwner>;
type DesktopGenerationState = {
  owner?: GenerationOwner;
  lastGeneration?: CodexDesktopGeneration;
  watcher?: FSWatcher;
  context?: OpenClawPluginServiceContextV2;
};

const state = defineCodexBuildState(
  "openclaw.codexDesktopGenerationState",
  (): DesktopGenerationState => ({}),
);

export function waitForCodexDesktopGeneration(): Promise<CodexDesktopGeneration | undefined> {
  const current = state();
  const owner = current.owner;
  return (current.watcher ? owner?.wait() : owner?.refresh()) ?? Promise.resolve(undefined);
}

export function createCodexDesktopGenerationService(params: {
  onGenerationChange: (generation: CodexDesktopGeneration) => void;
}): OpenClawPluginServiceV2 {
  const platform = process.platform;
  return {
    apiVersion: 2,
    id: "codex-desktop-generation",
    async start(ctx) {
      if (platform !== "darwin") {
        return;
      }
      const current = state();
      current.context = ctx;
      const owner = createCodexDesktopGenerationOwner({
        signal: ctx.scheduler.signal,
        readFingerprint: readMacOSDesktopGenerationFingerprint,
        onGenerationChange: params.onGenerationChange,
        initialGeneration: current.lastGeneration,
      });
      current.owner = owner;
      const candidateNames = new Set<string>(
        resolveMacOSDesktopCodexAppPathCandidates("darwin").map((candidate) => candidate.appName),
      );
      try {
        // Managed candidates live under this stable parent. Bundle replacement
        // needs no per-bundle watcher handoff; manual nested edits are best effort.
        current.watcher = watch(APPLICATIONS_PATH, { recursive: false }, (_eventType, filename) => {
          if (
            ctx.scheduler.signal.aborted ||
            (filename && !candidateNames.has(filename.split(path.sep)[0] ?? ""))
          ) {
            return;
          }
          owner.markDirty();
          void refreshGeneration(current, owner.wait());
        });
        current.watcher.on("error", (error) => reportWatcherFailure(current, error));
      } catch (error) {
        reportWatcherFailure(current, error);
      }
      void refreshGeneration(current, owner.refresh());
    },
    async stop() {
      const current = state();
      const owner = current.owner;
      const scheduler = current.context?.scheduler;
      scheduler?.beginClose();
      current.lastGeneration = current.owner?.read() ?? current.lastGeneration;
      current.owner = undefined;
      current.context = undefined;
      current.watcher?.close();
      current.watcher = undefined;
      await Promise.all([scheduler?.stop(), owner?.waitForIdle()]);
    },
  };
}

function reportWatcherFailure(current: DesktopGenerationState, error: unknown): void {
  if (current.context?.scheduler.signal.aborted) {
    return;
  }
  current.watcher?.close();
  current.watcher = undefined;
  current.owner?.markDirty();
  current.context?.serviceHealth?.reportFailure(error);
  current.context?.logger.warn(`codex desktop generation watcher failed: ${String(error)}`);
}

function refreshGeneration(
  current: DesktopGenerationState,
  refresh: Promise<CodexDesktopGeneration | undefined>,
): Promise<void> {
  return refresh
    .then(() => {
      if (!current.context?.scheduler.signal.aborted && current.watcher) {
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
