import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as observation from "openclaw/plugin-sdk/file-access-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createDirtyDirectoryWatch } from "./session-catalog-tree-watch.js";

vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
}));
const temp = useAutoCleanupTempDirTracker(afterEach);
const owners: Array<ReturnType<typeof createDirtyDirectoryWatch>> = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([2, 3])(
  "invalidates catalog reads at depth %s and recovers lost coverage",
  async (depth) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let created = createDeferred<observation.WatchSubscription>();
    const original = observation.watch;
    const attach = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
      expect(options.persistent).toBe(false);
      const subscription = original(authority, { ...options, mode: "poll" });
      created.resolve(subscription);
      return subscription;
    });
    const home = temp.make("claude-watch-");
    const directory = path.join(home, "projects");
    const source = path.join(directory, "existing", ...(depth === 3 ? ["workspace"] : []));
    await fs.mkdir(path.join(source, "subagents"), { recursive: true });
    const file = path.join(source, "session.jsonl");
    await fs.writeFile(file, "{}\n");
    const owner = createDirtyDirectoryWatch(directory, depth);
    owners.push(owner);
    expect(owner.takeDirty()).toBe("all");
    const subscription = await created.promise;
    await subscription.ready;
    await subscription.reconcile();
    expect(owner.takeDirty()).toBe("all");
    expect(owner.takeDirty()).toEqual(new Set());

    await fs.appendFile(file, "changed\n");
    await subscription.reconcile();
    expect(owner.takeDirty()).toEqual(new Set(["existing"]));
    expect(owner.takeDirty()).toEqual(new Set());
    await fs.writeFile(path.join(source, "subagents", "ignored.jsonl"), "{}\n");
    await subscription.reconcile();
    expect(owner.takeDirty()).toEqual(new Set());

    await fs.mkdir(path.join(directory, "new"));
    await subscription.reconcile();
    expect(owner.takeDirty()).toEqual(new Set(["new"]));
    await fs.rm(file);
    await subscription.reconcile();
    expect(owner.takeDirty()).toEqual(new Set(["existing"]));

    await fs.rename(directory, path.join(home, "retired"));
    await expect(subscription.reconcile()).rejects.toThrow();
    expect(owner.takeDirty()).toBe("all");
    expect(attach).toHaveBeenCalledTimes(1);
    await fs.mkdir(directory);
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 5_001);
    created = createDeferred<observation.WatchSubscription>();
    expect(owner.takeDirty()).toBe("all");
    const replacement = await created.promise;
    await replacement.ready;
    await replacement.reconcile();
    expect(owner.takeDirty()).toBe("all");
    expect(owner.takeDirty()).toEqual(new Set());
    await owner.close();
    expect(replacement.health().state).toBe("closed");
    expect(owner.takeDirty()).toBe("all");
    expect(attach).toHaveBeenCalledTimes(2);
  },
);

it("retries an unavailable watch on elapsed time even when the wall clock rolls back", async () => {
  const realDateNow = Date.now.bind(Date);
  let elapsed = 0;
  let wallOffset = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + wallOffset);
  const unavailable: observation.WatchSubscription = {
    health: () => ({ state: "unavailable", mode: "poll", directories: 0 }),
    ready: Promise.resolve(),
    setScopes: async () => {},
    reconcile: async () => {},
    close: async () => {},
    [Symbol.asyncDispose]: async () => {},
  };
  const attach = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    options.onHealth?.({ state: "unavailable", mode: "poll", directories: 0 });
    return unavailable;
  });
  const home = temp.make("claude-watch-rollback-");
  const directory = path.join(home, "projects");
  await fs.mkdir(path.join(directory, "existing"), { recursive: true });
  const owner = createDirtyDirectoryWatch(directory, 2);
  owners.push(owner);
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(1));
  // The watch reports unavailable; the retry deadline (elapsed + 5s) has not arrived yet.
  expect(owner.takeDirty()).toBe("all");
  expect(attach).toHaveBeenCalledTimes(1);

  // The wall clock rolls back an hour while elapsed time advances past the 5s retry window:
  // a Date.now()-keyed retryAt would never be reached, but performance.now() retries on schedule.
  wallOffset -= 3_600_000;
  elapsed += 5_001;
  await vi.waitFor(() => {
    expect(owner.takeDirty()).toBe("all");
    expect(attach).toHaveBeenCalledTimes(2);
  });
  await owner.close();
});
