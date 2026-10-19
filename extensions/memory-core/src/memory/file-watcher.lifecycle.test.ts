import { AsyncLocalStorage } from "node:async_hooks";
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
    extraPaths: ConstructorParameters<typeof MemoryFileWatcher>[0]["settings"]["extraPaths"] = [],
    {
      agentId = "main",
      workspaceDir = state.workspaceDir,
      images = false,
      runInBackgroundContext = AsyncLocalStorage.snapshot(),
    }: {
      agentId?: string;
      workspaceDir?: string;
      images?: boolean;
      runInBackgroundContext?: ConstructorParameters<
        typeof MemoryFileWatcher
      >[0]["runInBackgroundContext"];
    } = {},
  ) {
    const onDirty = vi.fn();
    const onUnavailable = vi.fn();
    const watcher = new MemoryFileWatcher({
      runInBackgroundContext,
      workspaceDir,
      agentId,
      settings: {
        extraPaths,
        multimodal: {
          enabled: images,
          modalities: images ? ["image"] : [],
          maxFileBytes: 10485760,
        },
        sync: { watchDebounceMs: debounce },
      },
      onChange,
      onDirty,
      onUnavailable,
    });
    owners.push(watcher);
    return { watcher, onChange, onDirty, onUnavailable };
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
      const { watcher } = owner();
      await watcher.start();
      expect(observer.observations.length).toBeGreaterThan(0);
      for (const entry of observer.observations) {
        expect(entry.options.mode).toBe(poll === "true" ? "poll" : "auto");
        expect(entry.options.pollIntervalMs).toBe(expected);
        expect(entry.options.intervalMs).toBe(300_000);
        entry.health({ state: "ready", mode: "poll" });
      }
      expect(watcher.health()).toEqual(
        observer.observations.map(() =>
          expect.objectContaining({
            mode: "poll",
            pollingFallback: poll !== "true",
            pollIntervalMs: expected,
          }),
        ),
      );
    },
  );

  it("shares roots across agents, fans out selected events, and joins the last release", async () => {
    const extra = state.path("shared", "notes");
    await fs.mkdir(extra, { recursive: true });
    const indexed = Array.from({ length: 3 }, () => createDeferred<void>());
    const agents = indexed.map((done, index) =>
      owner(
        vi.fn(() => done.resolve()),
        0,
        [extra],
        { agentId: `agent-${index}` },
      ),
    );
    await Promise.all(agents.map(({ watcher }) => watcher.start()));
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
      entry.dirty([
        {
          path: path.relative(entry.root.rootDir, path.join(extra, "deleted.md")),
          type: "structural",
        },
      ]);
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
    const replacement = owner(undefined, 0, [extra]);
    await replacement.watcher.start();
    expect(observer.observations).toHaveLength(4);
  });

  it.each([
    [false, false],
    [true, true],
    [true, false],
  ])("retains the shared baseline for image policies %s then %s", async (images, peerImages) => {
    const first = owner(undefined, 0, [], { images });
    await first.watcher.start();
    const entry = observer.observations[0]!;
    const peer = owner(undefined, 0, [], { agentId: "peer", images: peerImages });
    await peer.watcher.start();
    expect(observer.observations).toHaveLength(1);
    expect(entry.setScopes).not.toHaveBeenCalled();
    expect(first.onDirty).not.toHaveBeenCalled();
    expect(peer.onDirty).toHaveBeenCalledOnce();
    expect(peer.watcher.health()[0]?.state).toBe("ready");

    await peer.watcher.close();
    expect(entry.setScopes).not.toHaveBeenCalled();
    expect(entry.close).not.toHaveBeenCalled();
    entry.dirty();
    expect(first.onDirty).toHaveBeenCalledOnce();
    expect(peer.onDirty).toHaveBeenCalledOnce();
  });

  it("rebaselines changed file kinds even when the shared scopes stay the same", async () => {
    const text = owner();
    await text.watcher.start();
    const entry = observer.observations[0]!;
    const scopes = entry.options.scopes;
    const image = {
      path: path.relative(entry.root.rootDir, path.join(state.workspaceDir, "memory", "photo.png")),
      kind: "file" as const,
    };
    expect(entry.options.exclude?.(image)).toBe(true);
    const media = owner(undefined, 0, [], { agentId: "media", images: true });
    await media.watcher.start();
    expect(entry.options.scopes).toEqual(scopes);
    expect(entry.setScopes).toHaveBeenCalledOnce();
    expect(entry.options.exclude?.(image)).toBe(false);
    entry.dirty([{ path: image.path, type: "content" }]);
    expect(text.onDirty).not.toHaveBeenCalled();
    expect(media.onDirty).toHaveBeenCalledOnce();
    await media.watcher.close();
    expect(entry.setScopes).toHaveBeenCalledTimes(2);
    expect(entry.options.exclude?.(image)).toBe(true);
  });

  it("does not share a replaced root with an agent admitted to the new directory", async () => {
    const parent = state.path("shared");
    const notes = path.join(parent, "notes");
    await fs.mkdir(notes, { recursive: true });
    const original = owner(undefined, 0, [notes], { agentId: "original" });
    await original.watcher.start();
    await fs.rename(parent, state.path("retired"));
    await fs.mkdir(notes, { recursive: true });
    const replacement = owner(undefined, 0, [notes], { agentId: "replacement" });
    await replacement.watcher.start();
    replacement.onDirty.mockClear();
    const entries = observer.observations.filter((entry) => entry.root.rootDir === parent);
    expect(entries).toHaveLength(2);
    entries[1]!.dirty([{ path: "notes/new.md", type: "content" }]);
    expect(replacement.onDirty).toHaveBeenCalledOnce();
    expect(original.onDirty).not.toHaveBeenCalled();
    expect(replacement.onUnavailable).not.toHaveBeenCalled();
  });

  it.each(["invalidate", "health", "unavailable"] as const)(
    "retires rejected %s delivery without stranding a shared peer or retrying",
    async (notification) => {
      let accepting = true;
      const failure = new Error("plugin instance retired");
      const retired = owner(undefined, 0, [], {
        runInBackgroundContext: (run) => {
          if (!accepting) {
            throw failure;
          }
          return run();
        },
      });
      const healthy = owner(undefined, 0, [], { agentId: "healthy" });
      await retired.watcher.start();
      await healthy.watcher.start();
      expect(observer.observations).toHaveLength(1);
      const shared = observer.observations[0]!;
      accepting = false;
      try {
        expect(() => {
          if (notification === "invalidate") {
            shared.dirty();
          } else {
            shared.health({ state: notification === "health" ? "ready" : "unavailable" });
          }
        }).not.toThrow();
      } finally {
        accepting = true;
      }
      expect(retired.onUnavailable).toHaveBeenCalledOnce();
      expect(retired.onDirty).toHaveBeenCalledOnce();
      expect(retired.watcher.health()).toEqual([]);
      if (notification !== "unavailable") {
        expect(healthy.onUnavailable).not.toHaveBeenCalled();
        expect(shared.close).not.toHaveBeenCalled();
      }

      // Cleanup may enter the owner again; that must not restart ordinary observation.
      const recovered = createDeferred<void>();
      if (notification === "unavailable") {
        observer.created = () => recovered.resolve();
      }
      await vi.advanceTimersByTimeAsync(20_000);
      if (notification === "unavailable") {
        await recovered.promise;
      }
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
    let accepting = true;
    const physical = createDeferred<void>();
    observer.closeBarrier = physical.promise;
    const { watcher } = owner(undefined, 0, [], {
      runInBackgroundContext: (run) => {
        if (!accepting) {
          throw new Error("plugin instance retired");
        }
        return run();
      },
    });
    await watcher.start();
    accepting = false;
    try {
      expect(() => observer.observations[0]!.dirty()).not.toThrow();
    } catch (error) {
      physical.resolve();
      throw error;
    } finally {
      accepting = true;
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
    const { watcher, onDirty, onUnavailable } = owner();
    await watcher.start();
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
    const text = owner(undefined, 0, [{ path: notes, pattern: "text/*.md" }], { agentId: "text" });
    await text.watcher.start();
    const media = owner(undefined, 0, [notes, images], { agentId: "media", images: true });
    await media.watcher.start();
    const entry = observer.observations.find(
      (observation) => observation.root.rootDir === path.dirname(notes),
    )!;
    expect(observer.observations).toHaveLength(2);
    expect(entry.setScopes).toHaveBeenCalledOnce();
    expect(entry.options.scopes.map((scope) => scope.path).toSorted()).toEqual(["images", "notes"]);
    const image = { path: "notes/photo.png", kind: "file" as const };
    expect(entry.options.exclude?.(image)).toBe(false);
    entry.dirty([{ path: image.path, type: "content" }]);
    entry.dirty([{ path: "images/photo.png", type: "content" }]);
    entry.dirty([{ path: "notes/other.md", type: "content" }]);
    expect(text.onDirty).not.toHaveBeenCalled();
    expect(media.onDirty).toHaveBeenCalledTimes(3);
    entry.dirty([{ path: "notes/text/shared.md", type: "content" }]);
    expect(text.onDirty).toHaveBeenCalledOnce();
    expect(media.onDirty).toHaveBeenCalledTimes(4);
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
      const healthy = owner(undefined, 0, [healthyPath]);
      await healthy.watcher.start();
      const shared = observer.observations.find((entry) => entry.root.rootDir === parent)!;
      const failure = new Error("new scope cannot be observed");
      vi.spyOn(shared.subscription, "setScopes").mockImplementationOnce(async () => {
        if (failureKind === "watch-limit") {
          shared.health({
            state: "unavailable",
            failure: { operation: "watch", code: "watch-limit", error: failure },
          });
        }
        throw failure;
      });
      const failing = owner(undefined, 0, [failingPath], { agentId: "failing" });
      await failing.watcher.start();
      expect(healthy.onUnavailable).toHaveBeenCalledOnce();
      expect(failing.onUnavailable).toHaveBeenCalledOnce();
      expect(healthy.watcher.capacityDegraded).toBe(false);
      expect(failing.watcher.capacityDegraded).toBe(false);
      expect(shared.close).toHaveBeenCalledOnce();

      const recovered = createDeferred<void>();
      const entries = () => observer.observations.filter((entry) => entry.root.rootDir === parent);
      observer.created = () => {
        if (entries().length === 3) {
          recovered.resolve();
        }
      };
      await vi.advanceTimersByTimeAsync(500);
      await recovered.promise;
      const independent = entries().slice(1);
      const healthyEntry = independent.find(
        (entry) => entry.options.scopes[0]?.path === "healthy",
      )!;
      const failingEntry = independent.find(
        (entry) => entry.options.scopes[0]?.path === "unreadable",
      )!;
      failingEntry.health({
        state: "unavailable",
        failure: { operation: "watch", code: "watch-limit", error: failure },
      });
      expect(failing.watcher.capacityDegraded).toBe(true);
      const before = healthy.onDirty.mock.calls.length;
      healthyEntry.dirty([{ path: "healthy/note.md", type: "content" }]);
      expect(healthy.onDirty).toHaveBeenCalledTimes(before + 1);
      expect(healthy.onUnavailable).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(entries()).toHaveLength(3);
      expect(healthyEntry.close).not.toHaveBeenCalled();
      await healthy.watcher.close();
      expect(healthyEntry.close).toHaveBeenCalledOnce();
    },
  );

  it("refreshes only selected structural changes while retaining ancestor discovery", async () => {
    const planning = vi.spyOn(MemoryWatchPolicy.prototype, "observations");
    const first = owner();
    const secondWorkspace = path.join(path.dirname(state.workspaceDir), "second-workspace");
    await fs.mkdir(path.join(secondWorkspace, "memory"), { recursive: true });
    const second = owner(undefined, 0, [], {
      agentId: "second",
      workspaceDir: secondWorkspace,
    });
    await first.watcher.start();
    await second.watcher.start();
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
    entry.dirty([
      {
        path: path.relative(entry.root.rootDir, path.join(state.workspaceDir, "memory", "gone.md")),
        type: "structural",
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.onDirty).toHaveBeenCalledOnce();
    expect(second.onDirty).not.toHaveBeenCalled();
    expect(planning).toHaveBeenCalledOnce();
    entry.dirty([{ path: ".", type: "structural" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.onDirty).toHaveBeenCalledTimes(2);
    expect(second.onDirty).toHaveBeenCalledOnce();
    expect(planning).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "ENOTSUP"])("reports fallback polling once with reason %s", async (code) => {
    const { watcher, onUnavailable } = owner();
    await watcher.start();
    const entry = observer.observations[0]!;
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
    expect(watcher.health()).toEqual([
      expect.objectContaining({ mode: "poll", pollingFallback: true, pollIntervalMs: 30_000 }),
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

  it("resets recovery only for selected polling facts, not peer or whole-scope invalidations", async () => {
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
    observer.observations.at(-1)!.dirty([{ path: "other-agent/note.md", type: "content" }]);
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
