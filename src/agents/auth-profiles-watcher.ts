import path from "node:path";
import chokidar from "chokidar";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listAgentIds, resolveAgentDir } from "./agent-scope-config.js";

// Watches every configured agent's auth-profiles.json and fires onChange when
// any of them is written. Covers the stale-FALSE case where a user adds
// credentials via an external tool (`codex login`, hand-edited file, etc.) —
// without the watcher the gateway's prepared auth map stays inert until the
// next reload or restart.

export type AuthProfilesWatcherHandle = {
  stop: () => Promise<void>;
};

type WatcherLog = {
  warn: (msg: string) => void;
};

export function watchAuthProfilesForChanges(params: {
  cfg: OpenClawConfig;
  onChange: () => void;
  log?: WatcherLog;
}): AuthProfilesWatcherHandle {
  const watchPaths = listAgentIds(params.cfg).map((agentId) =>
    path.join(resolveAgentDir(params.cfg, agentId), "auth-profiles.json"),
  );
  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    usePolling: Boolean(process.env.VITEST),
  });
  let closed = false;
  watcher.on("all", () => {
    try {
      params.onChange();
    } catch {
      // onChange errors must not crash the watcher.
    }
  });
  watcher.on("error", (err) => {
    if (closed) {
      return;
    }
    closed = true;
    params.log?.warn(`auth-profile watcher error: ${String(err)}`);
    void watcher.close().catch(() => {});
  });
  return {
    stop: async () => {
      closed = true;
      await watcher.close().catch(() => {});
    },
  };
}
