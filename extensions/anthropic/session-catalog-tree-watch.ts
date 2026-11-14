import fs from "node:fs/promises";
import path from "node:path";
import {
  admitObservationRoot,
  watch,
  type WatchSubscription,
} from "openclaw/plugin-sdk/file-access-runtime";

export type DirtyDirectoryWatch = ReturnType<typeof createDirtyDirectoryWatch>;

const WATCH_RETRY_MS = 5_000;
// Poll mode (Bun, or an FSEvents fallback) rescans the tree every second on the main
// thread. Without catalog readers that work is pure idle cost, so retire the watch.
const POLL_WATCH_IDLE_CLOSE_MS = 60_000;

export function createDirtyDirectoryWatch(directory: string, depth = 2) {
  let subscription: WatchSubscription | undefined;
  let starting: Promise<void> | undefined;
  let dirty: "all" | Set<string> = "all";
  let retryAt = 0;
  let closed = false;
  let lastReadAt = performance.now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdleClose = (delayMs: number) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (closed || starting || !subscription) {
        return;
      }
      const idleMs = performance.now() - lastReadAt;
      if (idleMs < POLL_WATCH_IDLE_CLOSE_MS) {
        scheduleIdleClose(POLL_WATCH_IDLE_CLOSE_MS - idleMs);
        return;
      }
      // The next read rescans everything and re-arms the watch immediately.
      const retired = subscription;
      subscription = undefined;
      dirty = "all";
      retryAt = 0;
      void retired.close().catch(() => {});
    }, delayMs);
    idleTimer.unref?.();
  };
  const start = () => {
    // The idle timer belongs to one subscription; a replacement may not poll.
    clearTimeout(idleTimer);
    starting = (async () => {
      await subscription?.close();
      subscription = undefined;
      // Catalog reads already trust a configured projects root through a symlink.
      const canonical = await fs.realpath(directory);
      const authority = await admitObservationRoot(canonical, "allow");
      const scope = path.relative(authority.rootDir, canonical) || ".";
      if (closed) {
        return;
      }
      subscription = watch(authority, {
        mode: "auto",
        persistent: false,
        scopes: [{ path: scope, kind: "tree", depth }],
        onInvalidate: ({ changes }) => {
          if (!changes) {
            dirty = "all";
          } else if (dirty !== "all") {
            for (const change of changes) {
              const relative = path.relative(
                canonical,
                path.resolve(authority.rootDir, change.path),
              );
              const name = relative.split(path.sep, 1)[0];
              if (!name || name === "." || name === "..") {
                dirty = "all";
                break;
              }
              dirty.add(name);
            }
          }
        },
        onHealth: (health) => {
          if (health.state === "unavailable") {
            dirty = "all";
            retryAt = Date.now() + WATCH_RETRY_MS;
          }
        },
      });
      await subscription.ready;
      if (!closed && subscription.health().mode === "poll") {
        scheduleIdleClose(POLL_WATCH_IDLE_CLOSE_MS);
      }
    })()
      .catch(() => {
        dirty = "all";
        retryAt = Date.now() + WATCH_RETRY_MS;
      })
      .finally(() => {
        starting = undefined;
      });
  };
  start();
  return {
    /** Direct-child names to re-read, or "all" when coverage is uncertain. */
    takeDirty(this: void): "all" | Set<string> {
      lastReadAt = performance.now();
      const state = subscription?.health().state;
      if (closed || starting || !subscription || state === "unavailable" || state === "closed") {
        if (!closed && !starting && Date.now() >= retryAt) {
          start();
        }
        return "all";
      }
      const result = dirty;
      dirty = new Set();
      return result;
    },
    async close(this: void) {
      closed = true;
      clearTimeout(idleTimer);
      await starting;
      await subscription?.close();
    },
  };
}
