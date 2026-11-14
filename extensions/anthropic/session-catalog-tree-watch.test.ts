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
// Mirrors the production idle window for poll-mode catalog watches.
const POLL_WATCH_IDLE_CLOSE_MS = 60_000;
const temp = useAutoCleanupTempDirTracker(afterEach);
const owners: Array<ReturnType<typeof createDirtyDirectoryWatch>> = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map((owner) => owner.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retires an idle polling watch and re-arms it on the next catalog read", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const subscriptions: observation.WatchSubscription[] = [];
  const original = observation.watch;
  const attach = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    // Bun has no event transport, so "auto" resolves to this mode in the macOS worker.
    const subscription = original(authority, { ...options, mode: "poll" });
    subscriptions.push(subscription);
    return subscription;
  });
  const directory = path.join(temp.make("claude-watch-idle-"), "projects");
  await fs.mkdir(path.join(directory, "existing"), { recursive: true });
  const owner = createDirtyDirectoryWatch(directory);
  owners.push(owner);
  await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
  const first = subscriptions[0]!;
  await first.ready;
  await vi.waitFor(() => expect(owner.takeDirty()).toEqual(new Set()));

  // A reader inside the window keeps coverage; the deadline restarts from that read.
  await vi.advanceTimersByTimeAsync(POLL_WATCH_IDLE_CLOSE_MS - 1_000);
  expect(owner.takeDirty()).toEqual(new Set());
  await vi.advanceTimersByTimeAsync(POLL_WATCH_IDLE_CLOSE_MS - 1_000);
  expect(first.health().state).not.toBe("closed");

  await vi.advanceTimersByTimeAsync(1_001);
  await vi.waitFor(() => expect(first.health().state).toBe("closed"));
  expect(attach).toHaveBeenCalledTimes(1);

  // Changes made while unwatched are covered by a full rescan.
  await fs.mkdir(path.join(directory, "new"));
  expect(owner.takeDirty()).toBe("all");
  await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2));
  const second = subscriptions[1]!;
  await second.ready;
  await second.reconcile();
  await vi.waitFor(() => expect(owner.takeDirty()).toEqual(new Set()));
  await fs.mkdir(path.join(directory, "newer"));
  await second.reconcile();
  expect(owner.takeDirty()).toEqual(new Set(["newer"]));
});

it("keeps an event-backed replacement armed after a polling watch restarts", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const subscriptions: observation.WatchSubscription[] = [];
  const original = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    const subscription = original(authority, { ...options, mode: "poll" });
    subscriptions.push(subscription);
    // The replacement reports events, as after macOS FSEvents admission recovers.
    return subscriptions.length === 1
      ? subscription
      : { ...subscription, health: () => ({ ...subscription.health(), mode: "events" }) };
  });
  const home = temp.make("claude-watch-restart-");
  const directory = path.join(home, "projects");
  await fs.mkdir(directory, { recursive: true });
  const owner = createDirtyDirectoryWatch(directory);
  owners.push(owner);
  await vi.waitFor(() => expect(subscriptions).toHaveLength(1));
  await subscriptions[0]!.ready;
  await fs.rename(directory, path.join(home, "retired"));
  await expect(subscriptions[0]!.reconcile()).rejects.toThrow();
  await fs.mkdir(directory);
  // Pass the retry backoff on the wall and the monotonic clock.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
  await vi.advanceTimersByTimeAsync(5_001);
  expect(owner.takeDirty()).toBe("all");
  await vi.waitFor(() => expect(subscriptions).toHaveLength(2));
  await subscriptions[1]!.ready;

  await vi.advanceTimersByTimeAsync(POLL_WATCH_IDLE_CLOSE_MS + 1_000);
  expect(subscriptions[1]!.health().state).not.toBe("closed");
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
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
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
