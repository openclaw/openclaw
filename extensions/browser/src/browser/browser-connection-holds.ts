/**
 * Process-wide holds on cached browser connections, keyed like the Playwright
 * connection cache. Every profile runtime that shares a connection shares its
 * holds: profile operations, active traces, screencast viewers, and armed dialog
 * responses each hold the connection they use until they end.
 *
 * A connection owner can watch for idleness to release a connection that should
 * not stay attached between uses. The watch fires only after nothing has held the
 * connection for its full delay, so no runtime can release work another runtime
 * still holds, and teardown cancels the watch with the connection it belongs to.
 */

/**
 * Key by endpoint without credentials. A relay profile receives its process-only
 * credential during its first operation, after that operation already holds the endpoint.
 */
function connectionKey(raw: string): string {
  const url = URL.parse(raw);
  if (url && (url.username || url.password)) {
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  }
  return raw.replace(/\/$/, "");
}

type IdleWatch = {
  delayMs: number;
  onIdle: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

const holdCounts = new Map<string, number>();
const idleWatches = new Map<string, IdleWatch>();

function armIdleWatch(key: string, watch: IdleWatch): void {
  clearTimeout(watch.timer);
  watch.timer = setTimeout(() => {
    watch.timer = undefined;
    if (idleWatches.get(key) === watch && !holdCounts.has(key)) {
      watch.onIdle();
    }
  }, watch.delayMs);
  watch.timer.unref?.();
}

/** Hold one connection until the returned release runs; release is idempotent. */
export function holdBrowserConnection(cdpUrl: string): () => void {
  const key = connectionKey(cdpUrl);
  holdCounts.set(key, (holdCounts.get(key) ?? 0) + 1);
  const watch = idleWatches.get(key);
  if (watch) {
    clearTimeout(watch.timer);
    watch.timer = undefined;
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (holdCounts.get(key) ?? 1) - 1;
    if (remaining > 0) {
      holdCounts.set(key, remaining);
      return;
    }
    holdCounts.delete(key);
    const idle = idleWatches.get(key);
    if (idle) {
      armIdleWatch(key, idle);
    }
  };
}

export function isBrowserConnectionHeld(cdpUrl: string): boolean {
  return holdCounts.has(connectionKey(cdpUrl));
}

/**
 * Call `onIdle` once nothing has held this connection for `delayMs`. A later
 * watch for the same key replaces this one; the returned stop cancels it.
 */
export function watchBrowserConnectionIdle(
  cdpUrl: string,
  delayMs: number,
  onIdle: () => void,
): () => void {
  const key = connectionKey(cdpUrl);
  const previous = idleWatches.get(key);
  if (previous) {
    clearTimeout(previous.timer);
  }
  const watch: IdleWatch = { delayMs, onIdle };
  idleWatches.set(key, watch);
  if (!holdCounts.has(key)) {
    armIdleWatch(key, watch);
  }
  return () => {
    clearTimeout(watch.timer);
    watch.timer = undefined;
    if (idleWatches.get(key) === watch) {
      idleWatches.delete(key);
    }
  };
}
