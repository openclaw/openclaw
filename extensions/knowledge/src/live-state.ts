import { watch, lstatSync, realpathSync, type FSWatcher } from "node:fs";
import path from "node:path";

/** Notifications contain no record data. Reconciliation always uses an authorized read. */
export class LiveState {
  private watchers: FSWatcher[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private scopeIdentity = "";
  private rootIdentity = "";
  state: "stopped" | "watching" | "unavailable" = "stopped";
  constructor(
    private readonly root: string,
    private readonly changed: () => void,
  ) {}
  start() {
    this.stop();
    this.stopped = false;
    try {
      for (const target of [this.root, path.join(this.root, "private")]) {
        const stat = lstatSync(target);
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(target) !== target) {
          throw new Error("Unsafe watch root");
        }
      }
      const rootStat = lstatSync(this.root);
      this.rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
      const scope = lstatSync(path.join(this.root, "private"));
      this.scopeIdentity = `${scope.dev}:${scope.ino}`;
      const root = watch(this.root, { persistent: false }, (_, filename) => {
        if (String(filename) === "private") {
          try {
            const stat = lstatSync(path.join(this.root, "private"));
            if (`${stat.dev}:${stat.ino}` !== this.scopeIdentity) {
              this.start();
            }
          } catch {
            this.closeWatchers();
            this.state = "unavailable";
          }
          this.invalidate();
        } else if (!filename || filename === "vault.json") {
          this.invalidate();
        }
      });
      this.watchers.push(root);
      const privateScope = watch(
        path.join(this.root, "private"),
        { recursive: true, persistent: false },
        (_, filename) => {
          const parts = (filename ?? "").split(/[\\/]/);
          if (parts.some((part) => part.startsWith("."))) {
            return;
          }
          this.invalidate();
        },
      );
      this.watchers.push(privateScope);
      for (const watcher of this.watchers) {
        watcher.on("error", () => {
          this.closeWatchers();
          this.state = "unavailable";
          this.invalidate();
        });
      }
      this.state = "watching";
    } catch {
      this.closeWatchers();
      this.state = "unavailable";
    }
  }
  ensureWatching() {
    if (this.stopped) {
      return;
    }
    try {
      const root = lstatSync(this.root),
        scope = lstatSync(path.join(this.root, "private"));
      if (
        this.state !== "watching" ||
        `${root.dev}:${root.ino}` !== this.rootIdentity ||
        `${scope.dev}:${scope.ino}` !== this.scopeIdentity
      ) {
        this.start();
      }
    } catch {
      this.closeWatchers();
      this.state = "unavailable";
    }
  }
  invalidate() {
    if (this.stopped || this.timer) {
      return;
    }
    // A fixed coalescing window (not reset on each event) avoids starvation.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) {
        this.changed();
      }
    }, 150);
    this.timer.unref();
  }
  private closeWatchers() {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.closeWatchers();
    this.state = "stopped";
  }
}
