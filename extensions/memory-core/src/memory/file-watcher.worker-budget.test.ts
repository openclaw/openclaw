import { root, type Root } from "@openclaw/fs-safe/root";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryFileWatcher } from "./file-watcher.js";

const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("@openclaw/fs-safe/watch", () => ({ watch: observer.watch }));

describe("Memory observation worker admission", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let authority: Root;
  let Watcher: typeof MemoryFileWatcher;
  let scopeCount = 1;
  const owners: MemoryFileWatcher[] = [];
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "memory-worker-budget" });
    authority = await root(state.workspaceDir);
  });
  afterAll(async () => state.cleanup());
  beforeEach(async () => {
    // A failed physical close intentionally poisons a process slot. Each test
    // represents a new process rather than exposing a production budget reset.
    vi.resetModules();
    observer.reset();
    scopeCount = 1;
    vi.useFakeTimers();
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    ({ MemoryFileWatcher: Watcher } = await import("./file-watcher.js"));
    const { MemoryWatchPolicy } = await import("./watch-policy.js");
    vi.spyOn(MemoryWatchPolicy.prototype, "observations").mockImplementation(async () => [
      {
        root: authority,
        selections: Array.from({ length: scopeCount }, (_, index) => ({
          scope: { path: index + ".md", kind: "entry" as const },
          lexical: authority.rootDir + "/" + index + ".md",
          core: true,
        })),
      },
    ]);
  });
  afterEach(async () => {
    await Promise.allSettled(owners.splice(0).map((watcher) => watcher.close()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  function owner() {
    const onUnavailable = vi.fn();
    const onDirty = vi.fn();
    const watcher = new Watcher({
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths: [],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
        sync: { watchDebounceMs: 50 },
      },
      onChange: vi.fn(),
      onUnavailable,
      onDirty,
    });
    owners.push(watcher);
    return { watcher, onUnavailable, onDirty };
  }
  async function fill(count: number) {
    const next = Array.from({ length: count }, owner);
    await Promise.all(next.map(({ watcher }) => watcher.start()));
    return next;
  }
  async function denied() {
    const next = owner();
    const creations = observer.watch.mock.calls.length;
    await next.watcher.start();
    expect(observer.watch).toHaveBeenCalledTimes(creations);
    expect(next.watcher.capacityDegraded).toBe(true);
    expect(next.onUnavailable).toHaveBeenCalledOnce();
    expect(next.onDirty).toHaveBeenCalledOnce();
    return next;
  }

  it("bounds workers across concurrent instances and keeps denied Memory dirty for search", async () => {
    const admitted = await fill(16);
    const unavailable = await denied();
    expect(observer.observations).toHaveLength(16);
    expect(observer.observations.every((entry) => entry.options.mode === "node")).toBe(true);
    await admitted[0]!.watcher.close();
    await fill(1);
    expect(observer.observations).toHaveLength(17);
    await unavailable.watcher.start();
    expect(unavailable.watcher.capacityDegraded).toBe(true);
    expect(observer.observations).toHaveLength(17);
  });

  it("preserves Root multi-scope grouping and counts every bounded scope chunk", async () => {
    scopeCount = 129;
    await fill(8);
    await denied();
    expect(observer.observations).toHaveLength(16);
    expect(observer.observations.map((entry) => entry.options.scopes.length)).toEqual(
      Array.from({ length: 8 }, () => [128, 1]).flat(),
    );
    expect(observer.observations.every((entry) => entry.root === authority)).toBe(true);
  });

  it("retires an admitted prefix rather than leaving an oversized Memory plan partially watched", async () => {
    scopeCount = 16 * 128 + 1;
    const next = owner();
    await next.watcher.start();
    expect(observer.observations).toHaveLength(16);
    expect(next.watcher.capacityDegraded).toBe(true);
    expect(next.onUnavailable).toHaveBeenCalledOnce();
    expect(next.onDirty).toHaveBeenCalledOnce();
    await next.watcher.close();
    expect(observer.observations.every((entry) => entry.close.mock.calls.length === 1)).toBe(true);
    scopeCount = 1;
    await fill(16);
    expect(observer.observations).toHaveLength(32);
  });

  it.each(["close", "health"])(
    "retains a construction-time %s slot until actual close joins",
    async (action) => {
      await fill(15);
      const physical = createDeferred<void>();
      observer.closeBarrier = physical.promise;
      const next = owner();
      let closing: Promise<void> | undefined;
      observer.created = () => {
        const entry = observer.observations.at(-1)!;
        if (action === "health") {
          entry.health({ state: "unavailable", error: new Error("scan") });
        }
        closing = next.watcher.close();
        const original = entry.close.getMockImplementation()!;
        entry.close.mockImplementation(() => {
          expect(next.watcher.close()).toBe(closing);
          return original();
        });
      };
      await next.watcher.start();
      observer.created = undefined;
      observer.closeBarrier = undefined;
      let joined = false;
      void closing!.then(() => {
        joined = true;
      });
      try {
        await denied();
        expect(joined).toBe(false);
        expect(observer.observations.at(-1)!.close).toHaveBeenCalledOnce();
      } finally {
        physical.resolve();
        await closing;
      }
      await fill(1);
      expect(observer.observations).toHaveLength(17);
    },
  );

  it("retains failed-close capacity across other owners and repeated shutdown", async () => {
    const physical = createDeferred<void>();
    observer.closeBarrier = physical.promise;
    const [failed] = await fill(1);
    observer.closeBarrier = undefined;
    const healthy = await fill(15);
    const closing = failed!.watcher.close();
    const rejected = expect(closing).rejects.toThrow("Memory watcher cleanup failed");
    physical.reject(new Error("physical close failed"));
    await rejected;
    expect(failed!.watcher.close()).toBe(closing);
    await denied();
    await healthy[0]!.watcher.close();
    await fill(1);
    await denied();
    expect(observer.observations).toHaveLength(17);
  });

  it("releases a constructor rejection with no acquired handle", async () => {
    observer.watch.mockImplementationOnce(() => {
      throw new Error("invalid watch options");
    });
    const failed = owner();
    await failed.watcher.start();
    await failed.watcher.close();
    await fill(16);
    expect(observer.observations).toHaveLength(16);
  });

  it("does not charge explicitly selected polling to the Node worker budget", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    await fill(20);
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    await fill(16);
    await denied();
    expect(observer.observations.filter((entry) => entry.options.mode === "poll")).toHaveLength(20);
    expect(observer.observations.filter((entry) => entry.options.mode === "node")).toHaveLength(16);
  });
});
