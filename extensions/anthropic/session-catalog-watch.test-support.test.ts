import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDirtyDirectoryWatch,
  type DirtyDirectoryWatch,
} from "./session-catalog-tree-watch.js";
import { createClaudeCatalogWatchDriver } from "./session-catalog-watch.test-support.js";

describe("Claude catalog synthetic watcher clock", () => {
  let watch: DirtyDirectoryWatch | undefined;

  afterEach(() => {
    watch?.close();
    watch = undefined;
    vi.restoreAllMocks();
  });

  it.each([65530.123, 66000.123])("arms and reports only changed children from %s ms", (start) => {
    vi.spyOn(performance, "now").mockReturnValue(start);
    const home = path.resolve("synthetic-claude-home");
    const driver = createClaudeCatalogWatchDriver(home);
    watch = createDirtyDirectoryWatch(path.join(home, ".claude", "projects"));
    watch.observeChildDirectories(["changed", "untouched"]);
    expect(watch.takeDirty()).toBe("all");
    driver.arm();
    expect(watch.takeDirty()).toBe("all");
    expect(watch.takeDirty()).toEqual(new Set());
    driver.change(".claude/projects/changed/session.jsonl");
    expect(watch.takeDirty()).toEqual(new Set(["changed"]));
    expect(watch.takeDirty()).toEqual(new Set());
  });
});
