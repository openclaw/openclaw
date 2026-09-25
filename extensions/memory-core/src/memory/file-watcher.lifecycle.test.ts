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
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watch }));
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
    // Existing lifecycle cases explicitly exercise native ownership; mode-policy
    // cases below clear or replace this override at the real watcher boundary.
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

  it.each([
    { platform: "linux", runtime: "node", mode: "node" },
    { platform: "darwin", runtime: "node", mode: "poll" },
    { platform: "win32", runtime: "node", mode: "poll" },
    { platform: "os400", runtime: "node", mode: "poll" },
    { platform: "linux", runtime: "bun", mode: "poll" },
    { platform: "linux", runtime: "deno", mode: "poll" },
    { platform: "linux", runtime: "other", mode: "poll" },
  ])(
    "selects the default Memory mode for $platform/$runtime",
    async ({ platform, runtime, mode }) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
      // Policy boundary only; native behavior still needs actual host proof.
      vi.stubGlobal("process", {
        ...process,
        platform,
        release: { ...process.release, name: runtime === "other" ? "other" : "node" },
        versions: {
          ...process.versions,
          bun: runtime === "bun" ? "1.4.2" : undefined,
          deno: runtime === "deno" ? "2.0.0" : undefined,
        },
      });
      const { watcher, onUnavailable } = owner();
      await watcher.start();
      expect(onUnavailable).not.toHaveBeenCalled();
      expect(observer.observations).toHaveLength(1);
      expect(observer.observations[0]!.options.mode).toBe(mode);
      expect(observer.observations[0]!.options.intervalMs).toBe(mode === "poll" ? 100 : undefined);
    },
  );

  it.each(["false", "0", ""])(
    "keeps native-only Memory unavailable after unsupported-host refusal (%s)",
    async (setting) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
      vi.stubGlobal("process", { ...process, platform: "darwin" });
      const unavailable = new Error(
        "descriptor-bound native observation requires Node.js on Linux; select polling explicitly",
      );
      observer.ready = Promise.reject(unavailable);
      void observer.ready.catch(() => {});
      const { watcher, onUnavailable, onDirty } = owner();
      await watcher.start();
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(onDirty).toHaveBeenCalledOnce();
      expect(watcher.capacityDegraded).toBe(false);
      await watcher.close();
      expect(observer.observations).toHaveLength(1);
      expect(observer.observations[0]!.options.mode).toBe("node");
      expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { configured: "1", interval: 20 },
    { configured: "250", interval: 250 },
    { configured: "invalid", interval: 100 },
    { configured: "2147483648", interval: 100 },
  ])("keeps explicit Memory polling cadence $configured", async ({ configured, interval }) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "TrUe");
    vi.stubEnv("CHOKIDAR_INTERVAL", configured);
    const { watcher } = owner();
    await watcher.start();
    expect(observer.observations).toHaveLength(1);
    expect(observer.observations[0]!.options).toMatchObject({ mode: "poll", intervalMs: interval });
  });

  it("runs admission and notifications in the service ALS, not the opening turn", async () => {
    const turn = new AsyncLocalStorage<string>();
    const contexts: Array<string | undefined> = [];
    observer.created = () => contexts.push(turn.getStore());
    const { watcher } = owner();
    await turn.run("opening turn", () => watcher.start());
    expect(contexts).toEqual([undefined]);
    await watcher.close();
    expect(observer.observations.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
  });

  it("dirties synchronously, debounces indexing, and fences retired notifications", async () => {
    const { watcher, onDirty, onChange } = owner(undefined, 50);
    await watcher.start();
    const entry = observer.observations[0]!;
    entry.dirty();
    expect(onDirty).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(onChange).toHaveBeenCalledOnce();
    await watcher.close();
    entry.dirty();
    await vi.advanceTimersByTimeAsync(100);
    expect(onChange).toHaveBeenCalledOnce();
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

  it("bounds selected detail and broadens an overflowing import burst", async () => {
    const { watcher, onChange } = owner();
    await watcher.start();
    const entry = observer.observations[0]!;
    const open = vi.spyOn(entry.root, "open");
    const prefix = path.relative(entry.root.rootDir, path.join(state.workspaceDir, "memory"));
    entry.dirty(
      Array.from({ length: 1025 }, (_, index) => ({
        path: path.join(prefix, index + ".md"),
        type: "content",
      })),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onChange).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(entry.options.maxPendingPaths).toBe(1024);
  });

  it("cancels synchronously and joins startup plus physical cleanup", async () => {
    const ready = createDeferred<void>();
    const physical = createDeferred<void>();
    const admitted = createDeferred<void>();
    observer.ready = ready.promise;
    observer.closeBarrier = physical.promise;
    observer.created = () => admitted.resolve();
    const { watcher, onChange } = owner();
    const starting = watcher.start();
    await admitted.promise;
    const closing = watcher.close();
    let joined = false;
    void closing.then(() => {
      joined = true;
    });
    expect(observer.observations[0]!.options.signal?.aborted).toBe(true);
    expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
    observer.observations[0]!.dirty();
    ready.resolve();
    await starting;
    expect(joined).toBe(false);
    physical.resolve();
    await closing;
    expect(joined).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
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

  it.each(["ENOSPC", "EMFILE", "ENFILE"])(
    "makes watch-side %s sticky refresh-on-search",
    async (code) => {
      const { watcher, onUnavailable, onDirty } = owner();
      await watcher.start();
      observer.observations[0]!.health({
        state: "unavailable",
        error: new Error(code),
        failure: { operation: "watch", code },
      });
      expect(watcher.capacityDegraded).toBe(true);
      expect(onUnavailable).toHaveBeenCalledOnce();
      expect(onDirty).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(observer.watch).toHaveBeenCalledOnce();
      expect(observer.observations[0]!.close).toHaveBeenCalledOnce();
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
      error: new Error("full disk"),
      failure: { operation: "scan", code: "ENOSPC" },
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
    old.dirty();
    await vi.advanceTimersByTimeAsync(1);
    expect(onChange).toHaveBeenCalledTimes(count);
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
        error: new Error("temporary metadata failure"),
        failure: { operation: "scan", code: "EACCES" },
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

  it.each(["node", "poll"] as const)(
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
      expect(observer.observations.every((entry) => entry.options.mode === mode)).toBe(true);
      first!.health({ state: "starting", directories: 9_000, observedDirectories: 9_000 });
      expect(warnings).not.toHaveBeenCalled();
      const facts = (count: number) => ({
        state: "ready" as const,
        directories: mode === "node" ? count : 0,
        observedDirectories: mode === "poll" ? count : 9_000,
      });
      first!.health(facts(1_000));
      expect(warnings).not.toHaveBeenCalled();
      second!.health(facts(1_001));
      expect(warnings).toHaveBeenCalledOnce();
      const message = String(warnings.mock.calls[0]![0]);
      expect(message).toContain(
        "tracking 2001 " + (mode === "node" ? "registered directories" : "observed directories"),
      );
      expect(message).toContain(
        mode === "node" ? "file-watch/open-file limits" : "metadata polling work",
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
      error: new Error("scan"),
      failure: { operation: "scan" },
    });
    physical.reject(failure);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(observer.watch).toHaveBeenCalledOnce();
    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({ errors: [failure] });
  });
});
