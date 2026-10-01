import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";

/** Controls OS event delivery while exercising the real watcher and filesystem cache owners. */
export function createClaudeCatalogWatchDriver(home: string) {
  const watchers = new Map<string, { watcher: Watcher; recursive: boolean }>();
  class Watcher extends EventEmitter {
    constructor(private readonly root: string) {
      super();
    }
    close() {
      if (watchers.get(this.root)?.watcher === this) {
        watchers.delete(this.root);
      }
      this.removeAllListeners();
    }
    ref() {
      return this;
    }
    unref() {
      return this;
    }
  }
  const nativeWatch = fs.watch.bind(fs);
  vi.spyOn(fs, "watch").mockImplementation(
    (
      target: fs.PathLike,
      options: fs.WatchOptionsWithStringEncoding | fs.WatchListener<string>,
      listener?: fs.WatchListener<string>,
    ) => {
      const root = String(target);
      if (!root.startsWith(`${home}${path.sep}`)) {
        return typeof options === "function"
          ? nativeWatch(target, options)
          : nativeWatch(target, options, listener);
      }
      const watcher = new Watcher(root);
      const callback = listener ?? (typeof options === "function" ? options : undefined);
      if (callback) {
        watcher.on("change", callback);
      }
      watchers.set(root, {
        watcher,
        recursive: typeof options === "object" && options.recursive === true,
      });
      return watcher;
    },
  );
  // Integer steps keep the exact arming interval independent of fractional host-clock precision.
  let monotonicNow = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  return {
    arm: () => {
      monotonicNow += 250;
    },
    change: (file: string, event: fs.WatchEventType = "change") => {
      const absolute = path.resolve(home, file);
      const selected = [...watchers]
        .filter(([root, { recursive }]) =>
          recursive ? absolute.startsWith(`${root}${path.sep}`) : path.dirname(absolute) === root,
        )
        .toSorted(([left], [right]) => right.length - left.length)[0];
      if (!selected) {
        throw new Error(`No catalog watcher covers ${absolute}`);
      }
      const [root, { watcher }] = selected;
      watcher.emit("change", event, path.relative(root, absolute));
    },
  };
}
