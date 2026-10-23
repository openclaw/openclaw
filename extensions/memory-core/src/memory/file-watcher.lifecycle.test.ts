import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileWatcher, type MemoryFileWatcherOptions } from "./file-watcher.js";
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
type Observation = (typeof observer.observations)[number];
const calls = (...spies: { mock: { calls: unknown[] } }[]) =>
  spies.map((spy) => spy.mock.calls.length);
function unavailable(entry: Observation, operation: "scan" | "watch", error: Error, code?: string) {
  entry.health({ state: "unavailable", failure: { operation, error, code } });
}
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
  function owner({
    images = false,
    extraPaths = [],
    onChange = vi.fn<() => void | Promise<void>>(),
    ...options
  }: Partial<
    Pick<MemoryFileWatcherOptions, "agentId" | "workspaceDir" | "runInBackgroundContext">
  > & {
    onChange?: ReturnType<typeof vi.fn<() => void | Promise<void>>>;
    extraPaths?: MemoryFileWatcherOptions["settings"]["extraPaths"];
    images?: boolean;
  } = {}) {
    const onDirty = vi.fn();
    const onUnavailable = vi.fn();
    const watcher = new MemoryFileWatcher({
      runInBackgroundContext: AsyncLocalStorage.snapshot(),
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths,
        multimodal: {
          enabled: images,
          modalities: images ? ["image"] : [],
          maxFileBytes: 10485760,
        },
        sync: { watchDebounceMs: 0 },
      },
      onChange,
      onDirty,
      onUnavailable,
      ...options,
    });
    owners.push(watcher);
    return { watcher, onChange, onDirty, onUnavailable };
  }
  async function start(options: Parameters<typeof owner>[0] = {}) {
    const result = owner(options);
    await result.watcher.start();
    return { ...result, entry: observer.observations[0]! };
  }
  function dirty(entry: Observation, file: string, type: "content" | "structural" = "content") {
    entry.dirty([{ path: file, type }]);
  }
  function selectedPath(entry: Observation, file: string) {
    return path.relative(entry.root.rootDir, path.join(state.workspaceDir, file));
  }
  function pauseDiscovery() {
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted policy receiver.
    const original = MemoryWatchPolicy.prototype.observations;
    const implementation: typeof original = async function (this: MemoryWatchPolicy, signal) {
      const groups = await original.call(this, signal);
      entered.resolve();
      await resume.promise;
      return groups;
    };
    vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementationOnce(implementation);
    return { entered, resume };
  }
  function admissionGate() {
    let accepting = true;
    return {
      runInBackgroundContext: <T>(run: () => T): T => {
        if (!accepting) {
          throw new Error("plugin instance retired");
        }
        return run();
      },
      reject(run: () => void) {
        accepting = false;
        try {
          expect(run).not.toThrow();
        } finally {
          accepting = true;
        }
      },
    };
  }
  function createdWhen(predicate = () => true) {
    const created = createDeferred<void>();
    observer.created = () => {
      if (predicate()) {
        created.resolve();
      }
    };
    return created.promise;
  }

  it.each([
    ["false", undefined, 30_000],
    ["false", "40", 40],
    ["true", undefined, 30_000],
    ["true", "40", 40],
    ["true", "60000", 60_000],
  ] as const)(
    "honors background polling defaults and overrides with polling=%s interval=%s",
    async (poll, interval, expected) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", poll);
      vi.stubEnv("CHOKIDAR_INTERVAL", interval);
      const { watcher } = await start();
      expect(observer.observations.length).toBeGreaterThan(0);
      for (const entry of observer.observations) {
        expect(entry.options).toMatchObject({
          mode: poll === "true" ? "poll" : "auto",
          pollIntervalMs: expected,
          intervalMs: 300_000,
        });
        entry.health({ state: "ready", mode: "poll" });
      }
      expect(watcher.health()).toMatchObject(
        observer.observations.map(() => ({
          mode: "poll",
          pollingFallback: poll !== "true",
          pollIntervalMs: expected,
        })),
      );
    },
  );

  it("shares roots across agents, fans out selected events, and joins the last release", async () => {
    const extra = state.path("shared", "notes");
    await fs.mkdir(extra, { recursive: true });
    const indexed = Array.from({ length: 3 }, () => createDeferred<void>());
    const agents = await Promise.all(
      indexed.map((done, index) =>
        start({
          onChange: vi.fn(() => done.resolve()),
          extraPaths: [extra],
          agentId: `agent-${index}`,
        }),
      ),
    );
    for (const { onDirty } of agents) {
      onDirty.mockClear();
    }
    const shared = observer.observations.filter((entry) =>
      entry.options.scopes.some((scope) => path.resolve(entry.root.rootDir, scope.path) === extra),
    );
    expect(shared).toHaveLength(1);
    expect(observer.observations).toHaveLength(2);
    const entry = shared[0]!;
    const invalidate = () =>
      dirty(entry, path.relative(entry.root.rootDir, path.join(extra, "deleted.md")), "structural");
    invalidate();
    expect(agents.map(({ onDirty }) => onDirty.mock.calls.length)).toEqual([1, 1, 1]);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all(indexed.map((done) => done.promise));
    await agents[0]!.watcher.close();
    expect(entry.close).not.toHaveBeenCalled();
    invalidate();
    expect(agents.map(({ onDirty }) => onDirty.mock.calls.length)).toEqual([1, 2, 2]);
    await agents[1]!.watcher.close();
    expect(entry.close).not.toHaveBeenCalled();
    const joined = createDeferred<void>();
    entry.close.mockImplementationOnce(() => joined.promise);
    let closed = false;
    const closing = agents[2]!.watcher.close().then(() => {
      closed = true;
    });
    expect(entry.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    invalidate();
    expect(agents.map(({ onDirty }) => onDirty.mock.calls.length)).toEqual([1, 2, 2]);
    joined.resolve();
    await closing;
    await start({ extraPaths: [extra] });
    expect(observer.observations).toHaveLength(4);
  });

  it.each([
    [false, false],
    [true, true],
    [true, false],
  ])("retains the shared baseline for image policies %s then %s", async (images, peerImages) => {
    const { entry, ...first } = await start({ images });
    const peer = await start({ agentId: "peer", images: peerImages });
    expect(observer.observations).toHaveLength(1);
    expect(calls(entry.setScopes, first.onDirty, peer.onDirty)).toEqual([0, 0, 1]);
    expect(peer.watcher.health()[0]?.state).toBe("ready");

    await peer.watcher.close();
    expect(calls(entry.setScopes, entry.close)).toEqual([0, 0]);
    entry.dirty();
    expect(calls(first.onDirty, peer.onDirty)).toEqual([1, 1]);
  });

  it("rebaselines changed file kinds even when the shared scopes stay the same", async () => {
    const { entry, ...text } = await start();
    const scopes = entry.options.scopes;
    const image = {
      path: selectedPath(entry, "memory/photo.png"),
      kind: "file" as const,
    };
    expect(entry.options.exclude?.(image)).toBe(true);
    const media = await start({ agentId: "media", images: true });
    expect(entry.options.scopes).toEqual(scopes);
    expect(entry.setScopes).toHaveBeenCalledOnce();
    expect(entry.options.exclude?.(image)).toBe(false);
    dirty(entry, image.path);
    expect(calls(text.onDirty, media.onDirty)).toEqual([0, 1]);
    await media.watcher.close();
    expect(entry.setScopes).toHaveBeenCalledTimes(2);
    expect(entry.options.exclude?.(image)).toBe(true);
  });

  it("does not share a replaced root with an agent admitted to the new directory", async () => {
    const parent = state.path("shared");
    const notes = path.join(parent, "notes");
    await fs.mkdir(notes, { recursive: true });
    const original = await start({ extraPaths: [notes], agentId: "original" });
    await fs.rename(parent, state.path("retired"));
    await fs.mkdir(notes, { recursive: true });
    const replacement = await start({ extraPaths: [notes], agentId: "replacement" });
    replacement.onDirty.mockClear();
    const entries = observer.observations.filter((entry) => entry.root.rootDir === parent);
    expect(entries).toHaveLength(2);
    dirty(entries[1]!, "notes/new.md");
    expect(calls(replacement.onDirty, original.onDirty, replacement.onUnavailable)).toEqual([
      1, 0, 0,
    ]);
  });

  it.each(["invalidate", "health", "unavailable"] as const)(
    "retires rejected %s delivery without stranding a shared peer or retrying",
    async (notification) => {
      const gate = admissionGate();
      const retired = await start(gate);
      const healthy = await start({ agentId: "healthy" });
      expect(observer.observations).toHaveLength(1);
      const shared = observer.observations[0]!;
      gate.reject(() => {
        if (notification === "invalidate") {
          shared.dirty();
        } else {
          shared.health({ state: notification === "health" ? "ready" : "unavailable" });
        }
      });
      expect(calls(retired.onUnavailable, retired.onDirty)).toEqual([1, 1]);
      expect(retired.watcher.health()).toEqual([]);
      if (notification !== "unavailable") {
        expect(calls(healthy.onUnavailable, shared.close)).toEqual([0, 0]);
      }

      // Cleanup may enter the owner again; that must not restart ordinary observation.
      const recovered = notification === "unavailable" ? createdWhen() : undefined;
      await vi.advanceTimersByTimeAsync(20_000);
      await recovered;
      expect(observer.observations).toHaveLength(notification === "unavailable" ? 2 : 1);
      expect(retired.watcher.health()).toEqual([]);
      expect(retired.onChange).not.toHaveBeenCalled();
      const before = healthy.onDirty.mock.calls.length;
      observer.observations.at(-1)!.dirty();
      expect(healthy.onDirty).toHaveBeenCalledTimes(before + 1);
      expect(retired.onDirty).toHaveBeenCalledOnce();
    },
  );

  it("joins physical retirement failures after background admission closes", async () => {
    const physical = createDeferred<void>();
    observer.closeBarrier = physical.promise;
    const gate = admissionGate();
    const { watcher } = await start(gate);
    try {
      gate.reject(() => observer.observations[0]!.dirty());
    } catch (error) {
      physical.resolve();
      throw error;
    }
    let settled = false;
    const closing = watcher.close().finally(() => {
      settled = true;
    });
    const failure = new Error("physical teardown failed");
    const rejected = expect(closing).rejects.toMatchObject({ errors: [failure] });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    physical.reject(failure);
    await rejected;
  });

  it("preserves errors from an admitted notification callback", async () => {
    const { onDirty, onUnavailable } = await start();
    const failure = new Error("admitted callback failed");
    onDirty.mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => observer.observations[0]!.dirty()).toThrow(failure);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("unions shared scopes and exclusions without widening an agent's selections", async () => {
    const notes = state.path("shared", "notes");
    const images = state.path("shared", "images");
    await fs.mkdir(notes, { recursive: true });
    await fs.mkdir(images);
    const text = await start({
      extraPaths: [{ path: notes, pattern: "text/*.md" }],
      agentId: "text",
    });
    const media = await start({ extraPaths: [notes, images], agentId: "media", images: true });
    const entry = observer.observations.find(
      (observation) => observation.root.rootDir === path.dirname(notes),
    )!;
    expect(observer.observations).toHaveLength(2);
    expect(entry.setScopes).toHaveBeenCalledOnce();
    expect(entry.options.scopes.map((scope) => scope.path).toSorted()).toEqual(["images", "notes"]);
    const image = { path: "notes/photo.png", kind: "file" as const };
    expect(entry.options.exclude?.(image)).toBe(false);
    for (const file of [image.path, "images/photo.png", "notes/other.md"]) {
      dirty(entry, file);
    }
    expect(calls(text.onDirty, media.onDirty)).toEqual([0, 3]);
    dirty(entry, "notes/text/shared.md");
    expect(calls(text.onDirty, media.onDirty)).toEqual([1, 4]);
    await media.watcher.close();
    expect(entry.setScopes).toHaveBeenCalledTimes(2);
    expect(entry.options.exclude?.(image)).toBe(true);
    expect(entry.close).not.toHaveBeenCalled();
  });

  it.each(["scan", "watch-limit"] as const)(
    "isolates shared %s failures so a failing scope cannot disable healthy peers",
    async (failureKind) => {
      const parent = state.path("shared");
      const healthyPath = path.join(parent, "healthy");
      const failingPath = path.join(parent, "unreadable");
      await fs.mkdir(healthyPath, { recursive: true });
      await fs.mkdir(failingPath);
      const healthy = await start({ extraPaths: [healthyPath] });
      const shared = observer.observations.find((entry) => entry.root.rootDir === parent)!;
      const failure = new Error("new scope cannot be observed");
      vi.spyOn(shared.subscription, "setScopes").mockImplementationOnce(async () => {
        if (failureKind === "watch-limit") {
          unavailable(shared, "watch", failure, "watch-limit");
        }
        throw failure;
      });
      const failing = await start({ extraPaths: [failingPath], agentId: "failing" });
      expect(calls(healthy.onUnavailable, failing.onUnavailable, shared.close)).toEqual([1, 1, 1]);
      expect([healthy.watcher.capacityDegraded, failing.watcher.capacityDegraded]).toEqual([
        false,
        false,
      ]);

      const entries = () => observer.observations.filter((entry) => entry.root.rootDir === parent);
      const recovered = createdWhen(() => entries().length === 3);
      await vi.advanceTimersByTimeAsync(500);
      await recovered;
      const independent = entries().slice(1);
      const healthyEntry = independent.find(
        (entry) => entry.options.scopes[0]?.path === "healthy",
      )!;
      const failingEntry = independent.find(
        (entry) => entry.options.scopes[0]?.path === "unreadable",
      )!;
      unavailable(failingEntry, "watch", failure, "watch-limit");
      expect(failing.watcher.capacityDegraded).toBe(true);
      const before = healthy.onDirty.mock.calls.length;
      dirty(healthyEntry, "healthy/note.md");
      expect(calls(healthy.onDirty, healthy.onUnavailable)).toEqual([before + 1, 1]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(entries()).toHaveLength(3);
      expect(healthyEntry.close).not.toHaveBeenCalled();
      await healthy.watcher.close();
      expect(healthyEntry.close).toHaveBeenCalledOnce();
    },
  );

  it("refreshes only selected structural changes while retaining ancestor discovery", async () => {
    const planning = vi.spyOn(MemoryWatchPolicy.prototype, "observations");
    const first = await start();
    const secondWorkspace = path.join(path.dirname(state.workspaceDir), "second-workspace");
    await fs.mkdir(path.join(secondWorkspace, "memory"), { recursive: true });
    const second = await start({
      agentId: "second",
      workspaceDir: secondWorkspace,
    });
    expect(observer.observations).toHaveLength(1);
    // Reuse real admission to make event delivery and planning counts deterministic.
    const plans = new Map(
      planning.mock.contexts.map((policy, index) => [policy, planning.mock.results[index]!.value]),
    );
    planning.mockImplementation(function (this: MemoryWatchPolicy) {
      return plans.get(this)!;
    });
    planning.mockClear();
    const entry = observer.observations[0]!;
    dirty(entry, selectedPath(entry, "memory/gone.md"), "structural");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(first.onDirty, second.onDirty, planning)).toEqual([1, 0, 1]);
    dirty(entry, ".", "structural");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(first.onDirty, second.onDirty, planning)).toEqual([2, 1, 3]);
  });

  it.each([undefined, "ENOTSUP"])("reports fallback polling once with reason %s", async (code) => {
    const { watcher, onUnavailable, entry } = await start();
    const failure = code
      ? { operation: "watch" as const, code, error: new Error("native backend unsupported") }
      : undefined;
    entry.health({ state: "ready", mode: "poll", failure });
    entry.health({ state: "reconciling" });
    entry.health({ state: "ready" });
    expect(warnings).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining("fallback polling every 30000 ms"),
    );
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining(code ?? "fs-safe did not report a reason"),
    );
    expect(watcher.health()).toMatchObject([
      { mode: "poll", pollingFallback: true, pollIntervalMs: 30_000 },
    ]);
    expect(onUnavailable).not.toHaveBeenCalled();
    if (failure) {
      expect(watcher.health()[0]?.failure?.error).toBe(String(failure.error));
    }
  });

  it("reports explicit polling without a fallback warning", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    const { watcher } = owner();
    await watcher.start();
    observer.observations[0]!.health({ state: "ready", mode: "poll" });
    expect(warnings).not.toHaveBeenCalled();
    expect(watcher.health()).toEqual([
      expect.objectContaining({ mode: "poll", pollingFallback: false, pollIntervalMs: 30_000 }),
    ]);
  });

  it("retains new dirty facts behind slow indexing without a zero-delay timer spin", async () => {
    const first = createDeferred<void>();
    const entered = createDeferred<void>();
    const onChange = vi.fn<() => void | Promise<void>>().mockImplementationOnce(() => {
      entered.resolve();
      return first.promise;
    });
    const { watcher } = await start({ onChange });
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
    const { entered, resume } = pauseDiscovery();
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
    const { watcher, onUnavailable, entry } = await start({ onChange });

    entry.dirty();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(onChange, onUnavailable)).toEqual([1, 0]);
    expect(warnings).toHaveBeenCalledWith("memory sync failed (watch): " + String(failure));
    expect(vi.getTimerCount()).toBe(0);

    entry.dirty();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls(onChange, onUnavailable)).toEqual([2, 0]);
    expect(entry.subscription.health().state).toBe("ready");
    expect(calls(observer.watch, entry.close)).toEqual([1, 0]);
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
    const { watcher, entry } = await start();
    const { entered, resume } = pauseDiscovery();
    entry.dirty();
    await entered.promise;
    try {
      unavailable(entry, "watch", new Error("watch limit"), "watch-limit");
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
      const { entry } = await start({ onChange });
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
      dirty(entry, path.relative(entry.root.rootDir, file));
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
    const { watcher, onChange, onUnavailable, entry: old } = await start();
    unavailable(old, "scan", new Error("full disk"), "ENOSPC");
    expect(watcher.capacityDegraded).toBe(false);
    expect(onUnavailable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500);
    expect(calls(onChange, observer.watch)).toEqual([1, 1]);
    const acquired = createdWhen();
    observer.closeBarrier = undefined;
    physical.resolve();
    await vi.advanceTimersByTimeAsync(500);
    await acquired;
    expect(observer.observations[1]!.root).toBe(old.root);
    const count = onChange.mock.calls.length;
    observer.observations[1]!.dirty();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(count + 1);
  });

  it("resets recovery only for selected polling facts, not peer or whole-scope invalidations", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    const planning = vi.spyOn(MemoryWatchPolicy.prototype, "observations");
    await start();
    // Keep admission real, then reuse its unchanged plan to isolate retry timing.
    const groups = await planning.mock.results[0]!.value;
    planning.mockResolvedValue(groups);
    const fail = () =>
      unavailable(
        observer.observations.at(-1)!,
        "scan",
        new Error("temporary metadata failure"),
        "EACCES",
      );
    for (let round = 0; round < 4; round++) {
      fail();
      await vi.advanceTimersByTimeAsync(500);
      expect(observer.watch).toHaveBeenCalledTimes(round + 2);
      const entry = observer.observations.at(-1)!;
      expect(entry.options.mode).toBe("poll");
      entry.dirty([{ path: selectedPath(entry, "memory/note.md"), type: "content" }], "reconcile");
      await vi.advanceTimersByTimeAsync(0);
    }
    fail();
    await vi.advanceTimersByTimeAsync(500);
    expect(observer.watch).toHaveBeenCalledTimes(6);
    observer.observations.at(-1)!.dirty(undefined, "reconcile");
    dirty(observer.observations.at(-1)!, "other-agent/note.md");
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
      await start({ extraPaths: [state.path("extra-parent", "notes")] });
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
    const { watcher } = await start();
    unavailable(observer.observations[0]!, "scan", new Error("scan"));
    physical.reject(failure);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer.watch).toHaveBeenCalledOnce();
    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
  });
});
