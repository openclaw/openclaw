import fs from "node:fs/promises";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { clearBootstrapSnapshot } from "./bootstrap-cache.js";
import { loadWorkspaceBootstrapFiles, type WorkspaceBootstrapFile } from "./workspace.js";

const log = createSubsystemLogger("bootstrap-preload");

interface PreloadState {
  workspaceDir: string;
  watcher?: FSWatcher;
  enabled: boolean;
}

const state: PreloadState = {
  workspaceDir: "",
  enabled: false,
};

/**
 * Pre-load workspace bootstrap files at startup and set up file watchers
 * to invalidate the cache when files change.
 *
 * This significantly reduces per-message latency by eliminating file I/O
 * on every request for workspace context files (AGENTS.md, SOUL.md, etc.)
 *
 * @param workspaceDir - The workspace directory to watch
 * @param options - Configuration options
 */
export async function initializeBootstrapPreload(
  workspaceDir: string,
  options: {
    /** Enable file watching (default: true) */
    watch?: boolean;
  } = {},
): Promise<void> {
  if (state.enabled && state.workspaceDir === workspaceDir) {
    log.warn("Bootstrap preload already initialized for this workspace");
    return;
  }

  state.workspaceDir = workspaceDir;
  state.enabled = true;

  const enableWatch = options.watch !== false;

  try {
    // Pre-load bootstrap files to populate the cache
    const startTime = Date.now();
    const files = await loadWorkspaceBootstrapFiles(workspaceDir);
    const elapsed = Date.now() - startTime;
    
    log.info(
      `Pre-loaded ${files.length} workspace bootstrap files in ${elapsed}ms (${files
        .map((f) => f.name)
        .join(", ")})`,
    );

    // Set up file watchers if enabled
    if (enableWatch) {
      await setupFileWatchers(workspaceDir, files);
    }
  } catch (error) {
    log.error("Failed to initialize bootstrap preload:", error);
    state.enabled = false;
    throw error;
  }
}

async function setupFileWatchers(
  workspaceDir: string,
  files: WorkspaceBootstrapFile[],
): Promise<void> {
  // Close existing watcher if any
  if (state.watcher) {
    await state.watcher.close();
  }

  // Watch all bootstrap file paths
  const filePaths = files.map((f) => path.join(workspaceDir, f.name));

  state.watcher = watch(filePaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  state.watcher.on("change", async (filePath: string) => {
    const fileName = path.basename(filePath);
    log.info(`Bootstrap file changed: ${fileName}, invalidating cache`);
    
    // Invalidate all session caches since we can't know which sessions use this file
    clearBootstrapSnapshot("*");
    
    // Re-load the changed file to warm the cache
    try {
      await loadWorkspaceBootstrapFiles(workspaceDir);
      log.debug(`Re-loaded workspace bootstrap files after ${fileName} change`);
    } catch (error) {
      log.error(`Failed to reload bootstrap files after ${fileName} change:`, error);
    }
  });

  state.watcher.on("unlink", (filePath: string) => {
    const fileName = path.basename(filePath);
    log.info(`Bootstrap file deleted: ${fileName}, invalidating cache`);
    clearBootstrapSnapshot("*");
  });

  state.watcher.on("error", (error: Error) => {
    log.error("Bootstrap file watcher error:", error);
  });

  log.info(`Watching ${filePaths.length} bootstrap files for changes`);
}

/**
 * Shut down the bootstrap preload system and clean up watchers.
 */
export async function shutdownBootstrapPreload(): Promise<void> {
  if (state.watcher) {
    await state.watcher.close();
    state.watcher = undefined;
  }
  state.enabled = false;
  log.info("Bootstrap preload shut down");
}

/**
 * Check if bootstrap preload is currently enabled.
 */
export function isBootstrapPreloadEnabled(): boolean {
  return state.enabled;
}
