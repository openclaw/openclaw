import path from "node:path";
import { vi } from "vitest";
import * as treeWatch from "./session-catalog-tree-watch.js";

/** Controls cache invalidation; the tree-watch suite covers actual filesystem observation. */
export function createClaudeCatalogWatchDriver(home: string) {
  const watchers = new Map<string, { armed: boolean; dirty: "all" | Set<string> }>();
  vi.spyOn(treeWatch, "createDirtyDirectoryWatch").mockImplementation((directory) => {
    const state = { armed: false, dirty: "all" as "all" | Set<string> };
    watchers.set(directory, state);
    return {
      takeDirty() {
        if (!state.armed) {
          return "all";
        }
        const dirty = state.dirty;
        state.dirty = new Set();
        return dirty;
      },
      async close() {
        watchers.delete(directory);
      },
    };
  });
  return {
    arm: () => {
      for (const state of watchers.values()) {
        state.armed = true;
      }
    },
    change: (file: string) => {
      const absolute = path.resolve(home, file);
      const selected = [...watchers].find(([directory]) =>
        absolute.startsWith(`${directory}${path.sep}`),
      );
      if (!selected) {
        throw new Error(`No catalog watcher covers ${absolute}`);
      }
      const [directory, state] = selected;
      if (state.dirty !== "all") {
        state.dirty.add(path.relative(directory, absolute).split(path.sep, 1)[0]!);
      }
    },
  };
}
