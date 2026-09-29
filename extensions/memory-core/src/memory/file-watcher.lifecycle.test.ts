import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileWatcher } from "./file-watcher.js";
import { MemoryWatchPolicy } from "./watch-policy.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));
const warnings = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (original) => {
  const actual =
    await original<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    createSubsystemLogger: (...args: Parameters<typeof actual.createSubsystemLogger>) => ({
      ...actual.createSubsystemLogger(...args),
      warn: warnings,
    }),
  };
});

describe("Memory observation lifecycle", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  const owners: MemoryFileWatcher[] = [];
  beforeEach(async () => {
    observer.reset();
    warnings.mockClear();
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    state = await createOpenClawTestState({ label: "memory-observation" });
    await fs.mkdir(path.join(state.workspaceDir, "memory"));
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await Promise.allSettled(owners.splice(0).map((watcher) => watcher.close()));
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await state.cleanup();
  });
  function owner(
    onChange = vi.fn<() => void | Promise<void>>(),
    debounce = 0,
    extraPaths: string[] = [],
  ) {
    const onDirty = vi.fn();
    const onUnavailable = vi.fn();
    const watcher = new MemoryFileWatcher({
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths,
        multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
        sync: { watchDebounceMs: debounce },
      },
      onChange,
      onDirty,
      onUnavailable,
    });
    owners.push(watcher);
    return { watcher, onChange, onDirty, onUnavailable };
  }

  it("retains new dirty facts behind slow indexing without a zero-delay timer spin", async () => {
    const first = createDeferred<void>();
    const entered = createDeferred<void>();
    const onChange = vi.fn<() => void | Promise<void>>().mockImplementationOnce(() => {
      entered.resolve();
      return first.promise;
    });
    const { watcher } = owner(onChange);
    await watcher.start();
    observer.observations[0]!.dirty();
    await vi.advanceTimersByTimeAsync(0);
    await entered.promise;
    for (let index = 0; index < 2000; index++) {
      observer.observations[0]!.dirty();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(onChange).toHaveBeenCalledOnce();
    first.resolve();
    await first.promise;
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(2);
    await watcher.close();
  });

  it("does not admit a late observer when close races initial Root discovery", async () => {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked below with the intercepted policy receiver via .call.
    const original = MemoryWatchPolicy.prototype.observations;
    vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementation(async function (
      this: MemoryWatchPolicy,
      signal,
    ) {
      const groups = await original.call(this, signal);
      entered.resolve();
      await resume.promise;
      return groups;
    });
    const { watcher } = owner();
    const starting = watcher.start();
    await entered.promise;
    const closing = watcher.close();
    resume.resolve();
    await Promise.all([starting, closing]);
    expect(observer.watch).not.toHaveBeenCalled();
  });

  it("keeps healthy observation available after indexing fails", async () => {
    const failure = new Error("indexing failed");
    const onChange = vi
      .fn<() => void | Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    const { watcher, onUnavailable } = owner(onChange);
    await watcher.start();
    const entry = observer.observations[0]!;

    entry.dirty();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(warnings).toHaveBeenCalledWith("memory sync failed (watch): " + String(failure));
    expect(vi.getTimerCount()).toBe(0);

    entry.dirty();
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(entry.subscription.health().state).toBe("ready");
    expect(observer.watch).toHaveBeenCalledOnce();
    expect(entry.close).not.toHaveBeenCalled();
    await watcher.close();
    expect(entry.close).toHaveBeenCalledOnce();
  });

  it("makes watch-limit sticky refresh-on-search", async () => {
    const code = "watch-limit";
    const { watcher, onUnavailable, onDirty } = owner();
    await watcher.start();
    observer.observations[0]!.health({
      state: "unavailable",
      failure: { operation: "watch", code, error: new Error(code) },
    });
    expect(watcher.capacityDegraded).toBe(true);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onDirty).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer.watch).toHaveBeenCalledOnce();
    expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
  });

  it("does not rearm when watch-limit retires observation during source discovery", async () => {
    const { watcher } = owner();
    await watcher.start();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the intercepted policy receiver.
    const original = MemoryWatchPolicy.prototype.observations;
    vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementationOnce(async function (
      this: MemoryWatchPolicy,
      signal,
    ) {
      const groups = await original.call(this, signal);
      entered.resolve();
      await resume.promise;
      return groups;
    });
    const entry = observer.observations[0]!;
    entry.dirty();
    await entered.promise;
    try {
      entry.health({
        state: "unavailable",
        failure: { operation: "watch", code: "watch-limit", error: new Error("watch limit") },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(entry.close).toHaveBeenCalledOnce();
      expect(watcher.capacityDegraded).toBe(true);
      resume.resolve();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(observer.watch).toHaveBeenCalledOnce();
    } finally {
      resume.resolve();
    }
  });

  it.each(["before", "after"] as const)(
    "settles selected edits with an undetailed invalidation %s the edit",
    async (order) => {
      const file = path.join(state.workspaceDir, "memory", "note.md");
      await fs.writeFile(file, "First write.");
      const indexed = createDeferred<void>();
      const onChange = vi.fn(() => indexed.resolve());
      const { watcher } = owner(onChange);
      await watcher.start();
      const entry = observer.observations[0]!;
      const samples = Array.from({ length: 3 }, () => createDeferred<void>());
      const open = entry.root.open.bind(entry.root);
      let sample = 0;
      const sampling = vi.spyOn(entry.root, "open").mockImplementation(async (...args) => {
        const opened = await open(...args);
        const captured = samples[sample++];
        const dispose = opened[Symbol.asyncDispose].bind(opened);
        vi.spyOn(opened, Symbol.asyncDispose).mockImplementation(async () => {
          await dispose();
          captured?.resolve();
        });
        return opened;
      });
      if (order === "before") {
        entry.dirty();
      }
      entry.dirty([{ path: path.relative(entry.root.rootDir, file), type: "content" }]);
      if (order === "after") {
        entry.dirty();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(
        await Promise.race([
          samples[0]!.promise.then(() => "sampled"),
          indexed.promise.then(() => "indexed"),
        ]),
      ).toBe("sampled");
      await vi.advanceTimersByTimeAsync(0);
      await fs.writeFile(file, "A longer second write, while settling.");
      await vi.advanceTimersByTimeAsync(100);
      await samples[1]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await indexed.promise;
      expect(onChange).toHaveBeenCalledOnce();
      expect(sampling).toHaveBeenCalledTimes(3);
    },
  );

  it("invalidates before slow retirement and reacquires scan failures under the same pinned Root", async () => {
    const physical = createDeferred<void>();
    observer.closeBarrier = physical.promise;
    const { watcher, onChange, onUnavailable } = owner();
    await watcher.start();
    const old = observer.observations[0]!;
    old.health({
      state: "unavailable",
      failure: { operation: "scan", code: "ENOSPC", error: new Error("full disk") },
    });
    expect(watcher.capacityDegraded).toBe(false);
    expect(onUnavailable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(onChange).toHaveBeenCalledOnce();
    expect(observer.watch).toHaveBeenCalledOnce();
    const acquired = createDeferred<void>();
    observer.created = () => acquired.resolve();
    observer.closeBarrier = undefined;
    physical.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await acquired.promise;
    expect(observer.observations[1]!.root).toBe(old.root);
    const count = onChange.mock.calls.length;
    observer.observations[1]!.dirty();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(count + 1);
  });

  it("resets recovery only for changed polling facts, not unchanged whole-scope reconciliation", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    const planning = vi.spyOn(MemoryWatchPolicy.prototype, "observations");
    const { watcher } = owner();
    await watcher.start();
    // Keep admission real, then reuse its unchanged plan to isolate retry timing.
    const groups = await planning.mock.results[0]!.value;
    planning.mockResolvedValue(groups);
    const fail = () =>
      observer.observations.at(-1)!.health({
        state: "unavailable",
        failure: {
          operation: "scan",
          code: "EACCES",
          error: new Error("temporary metadata failure"),
        },
      });
    for (let round = 0; round < 4; round++) {
      fail();
      await vi.advanceTimersByTimeAsync(500);
      expect(observer.watch).toHaveBeenCalledTimes(round + 2);
      const entry = observer.observations.at(-1)!;
      expect(entry.options.mode).toBe("poll");
      entry.dirty(
        [
          {
            path: path.relative(
              entry.root.rootDir,
              path.join(state.workspaceDir, "memory", "note.md"),
            ),
            type: "content",
          },
        ],
        "reconcile",
      );
      await vi.advanceTimersByTimeAsync(0);
    }
    fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(observer.watch).toHaveBeenCalledTimes(6);
    observer.observations.at(-1)!.dirty(undefined, "reconcile");
    await vi.advanceTimersByTimeAsync(0);
    fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(observer.watch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1500);
    expect(observer.watch).toHaveBeenCalledTimes(7);
  });

  it.each(["events", "poll"] as const)(
    "warns once from aggregated ready %s health with profile and agent remediation",
    async (mode) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", mode === "poll" ? "true" : "false");
      vi.stubEnv("OPENCLAW_PROFILE", "research");
      vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
      await fs.mkdir(state.path("extra-parent", "notes"), { recursive: true });
      const { watcher } = owner(undefined, 0, [state.path("extra-parent", "notes")]);
      await watcher.start();
      expect(observer.observations).toHaveLength(2);
      const [first, second] = observer.observations;
      expect(
        observer.observations.every((entry) => entry.subscription.health().mode === mode),
      ).toBe(true);
      first!.health({ state: "starting", directories: 9_000 });
      expect(warnings).not.toHaveBeenCalled();
      const facts = (count: number) => ({
        state: "ready" as const,
        directories: count,
      });
      first!.health(facts(1_000));
      expect(warnings).not.toHaveBeenCalled();
      second!.health(facts(1_001));
      expect(warnings).toHaveBeenCalledOnce();
      const message = String(warnings.mock.calls[0]![0]);
      expect(message).toContain("tracking 2001 observed directories");
      expect(message).toContain(
        mode === "events" ? "file-watch/open-file limits" : "metadata polling work",
      );
      expect(message).toContain("memory.search.extraPaths");
      expect(message).toContain("restart the Gateway");
      expect(message).toContain("openclaw --profile research memory index --force --agent main");
      first!.health(facts(5_000));
      second!.health(facts(5_000));
      expect(warnings).toHaveBeenCalledOnce();
    },
  );

  it("never rearms after actual close failure and preserves repeated close rejection", async () => {
    const failure = new Error("physical teardown failed");
    const physical = createDeferred<void>();
    observer.closeBarrier = physical.promise;
    const { watcher } = owner();
    await watcher.start();
    observer.observations[0]!.health({
      state: "unavailable",
      failure: { operation: "scan", error: new Error("scan") },
    });
    physical.reject(failure);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer.watch).toHaveBeenCalledOnce();
    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
  });
});
