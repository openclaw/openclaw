import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  isPathOwnedByAnotherRegisteredAgent as ownedByOther,
  normalizeAgentDirRegistryPath as normalizePath,
  registerResolvedAgentDir as registerDir,
  resolveRegisteredAgentIdForDir as ownerOf,
  unregisterResolvedAgentDir as unregisterDir,
} from "./agent-dir-registry.js";

vi.mock("node:worker_threads", () => ({ isMainThread: true }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const nativeWatchFs: {
  watch(
    filename: fs.PathLike,
    options: fs.WatchOptionsWithStringEncoding,
    listener: fs.WatchListener<string>,
  ): fs.FSWatcher;
} = fs;

class ReplayWatch extends EventEmitter implements fs.FSWatcher {
  close() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

beforeEach(() => {
  // These tests inject notifications; native transport has separate integration proof.
  if (process.platform === "darwin") {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  }
  vi.spyOn(nativeWatchFs, "watch").mockImplementation((directory, _options, listener) => {
    fs.accessSync(directory, fs.constants.R_OK);
    const watch = new ReplayWatch();
    watch.on("change", listener);
    return watch;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

function registered(owner: Parameters<typeof registerDir>[0]) {
  registerDir(owner);
  return { [Symbol.dispose]: () => unregisterDir(owner) };
}

function observeOwners(owners: Array<{ agentId: string; agentDir: string }>) {
  const watch = vi.spyOn(fs, "watch");
  owners.forEach((owner) => registerDir(owner));
  const closes = watch.mock.results.map((result) => {
    if (result.type !== "return") {
      throw new Error("Missing agent directory ancestor watch");
    }
    return vi.spyOn(result.value, "close");
  });
  return {
    watch,
    closes,
    [Symbol.dispose]() {
      owners.forEach((owner) => unregisterDir(owner));
      closes.forEach((close) => close.mockRestore());
      watch.mockRestore();
    },
  };
}

describe("agent directory registry", () => {
  it("detects registered ownership on either side of a cleanup boundary", () => {
    const root = path.join("/tmp", `openclaw-agent-dir-overlap-${process.pid}`);
    const agentDir = path.join(root, "agent");
    registerDir({ agentId: "current", agentDir });

    expect([
      ownedByOther({ agentId: "deleted", pathname: root }),
      ownedByOther({
        agentId: "deleted",
        pathname: path.join(agentDir, "openclaw-agent.sqlite"),
      }),
      ownedByOther({ agentId: "current", pathname: root }),
    ]).toEqual([true, true, false]);

    unregisterDir({ agentId: "current", agentDir });
  });

  it("keeps ownership stable through a symlinked parent after the agent dir is removed", () => {
    const root = tempDirs.make("openclaw-agent-dir-registry-");
    const realRoot = path.join(root, "real");
    const linkedRoot = path.join(root, "linked");
    const realAgentDir = path.join(realRoot, "agent");
    const linkedAgentDir = path.join(linkedRoot, "agent");
    fs.mkdirSync(realAgentDir, { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    using _ = registered({ agentId: "current", agentDir: realAgentDir });
    expect(ownerOf(linkedAgentDir)).toBe("current");
    registerDir({ agentId: "deleted", agentDir: linkedAgentDir });
    expect(ownerOf(realAgentDir)).toBeUndefined();
    expect(ownedByOther({ agentId: "deleted", pathname: linkedAgentDir })).toBe(true);
    expect(unregisterDir({ agentId: "deleted", agentDir: linkedAgentDir })).toBe(true);
    expect(ownerOf(realAgentDir)).toBe("current");

    fs.rmSync(realAgentDir, { recursive: true });
    expect(unregisterDir({ agentId: "current", agentDir: linkedAgentDir })).toBe(true);
    expect(ownerOf(realAgentDir)).toBeUndefined();
  });

  it("matches tilde paths against the effective custom home", () => {
    const root = tempDirs.make("openclaw-agent-dir-home-");
    const customHome = path.join(root, "home");
    const agentDir = path.join(customHome, "agents", "main", "agent");
    const env = { HOME: customHome, OPENCLAW_HOME: customHome };
    fs.mkdirSync(customHome, { recursive: true });

    using _ = registered({ agentId: "main", agentDir: "~/agents/main/agent", env });
    expect(ownerOf(agentDir, env)).toBe("main");
  });

  it("reuses observations across walks of more than 256 registered agents", () => {
    const root = tempDirs.make("openclaw-agent-dir-fleet-");
    const fleet = Array.from({ length: 810 }, (_, index) => ({
      agentId: `fleet-${index}`,
      agentDir: path.join(root, `fleet-${index}`, "agent"),
    }));
    for (const owner of fleet) {
      fs.mkdirSync(owner.agentDir, { recursive: true });
    }
    using observed = observeOwners(fleet);
    const { watch, closes } = observed;
    const initialWatches = watch.mock.calls.length;
    using realpath = vi.spyOn(fs.realpathSync, "native");
    for (const owner of fleet) {
      expect(registerDir(owner)).toBe(false);
      expect(ownerOf(owner.agentDir)).toBe(owner.agentId);
    }
    expect(watch).toHaveBeenCalledTimes(initialWatches);
    expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);
    expect(realpath).not.toHaveBeenCalled();
    // Destructive admission bypasses the prepared identity even when lookups reuse it.
    const { agentDir } = fleet[0]!;
    expect(normalizePath(agentDir)).toBe(fs.realpathSync.native(agentDir));
    expect(realpath).toHaveBeenCalled();
  });

  it("retains ancestor watches when a named notification leaves directory identity unchanged", () => {
    const agentDir = tempDirs.make("openclaw-agent-dir-unchanged-");
    using observed = observeOwners([{ agentId: "main", agentDir }]);
    const { watch, closes } = observed;
    const count = watch.mock.calls.length;
    const parentIndex = watch.mock.calls.findIndex(
      ([directory]) => directory === path.dirname(agentDir),
    );
    const parent = watch.mock.results[parentIndex];
    if (parent?.type !== "return") {
      throw new Error("Missing agent directory ancestor watch");
    }
    parent.value.emit("change", "change", path.basename(agentDir));
    expect(closes[parentIndex]).not.toHaveBeenCalled();
    expect(ownerOf(agentDir)).toBe("main");
    expect(watch).toHaveBeenCalledTimes(count);
  });

  it("resolves each prepared identity once per ancestor recovery sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const root = tempDirs.make("openclaw-agent-dir-recovery-");
    const agentDir = path.join(root, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    try {
      using _ = observeOwners([{ agentId: "main", agentDir }]);
      using realpath = vi.spyOn(fs.realpathSync, "native");
      vi.advanceTimersByTime(30_000);
      expect(realpath).toHaveBeenCalledExactlyOnceWith(agentDir);
      expect(ownerOf(agentDir)).toBe("main");
      await Promise.resolve();
      realpath.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(realpath).toHaveBeenCalledExactlyOnceWith(agentDir);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires ancestor watches on shutdown without losing registered ownership", async () => {
    const agentDir = tempDirs.make("openclaw-agent-dir-shutdown-");
    using observed = observeOwners([{ agentId: "main", agentDir }]);
    const { closes } = observed;
    expect(closes.length).toBeGreaterThan(0);
    await drainGlobalSingletonLifecycleState("restart", { retainSharedState: true });
    expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);
    await drainGlobalSingletonLifecycleState("shared-state");
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
    expect(ownerOf(agentDir)).toBe("main");
  });

  it("invalidates a prepared alias after its parent is replaced", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = tempDirs.make("openclaw-agent-dir-replaced-");
    const original = path.join(root, "original");
    const replacement = path.join(root, "replacement");
    const alias = path.join(root, "alias");
    for (const dir of [original, replacement]) {
      fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
    }
    fs.symlinkSync(original, alias, process.platform === "win32" ? "junction" : "dir");
    const agentDir = path.join(alias, "agent");
    registerDir({ agentId: "main", agentDir });
    try {
      expect(ownerOf(agentDir)).toBe("main");
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
      expect(unregisterDir({ agentId: "main", agentDir })).toBe(false);
      expect(ownedByOther({ agentId: "other", pathname: original })).toBe(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ownerOf(agentDir)).toBeUndefined();
      expect(ownerOf(path.join(original, "agent"))).toBe("main");
      registerDir({ agentId: "replacement", agentDir });
      expect(unregisterDir({ agentId: "main", agentDir })).toBe(false);
      expect(ownerOf(agentDir)).toBe("replacement");
    } finally {
      unregisterDir({ agentId: "replacement", agentDir });
      unregisterDir({ agentId: "main", agentDir: path.join(original, "agent") });
      vi.useRealTimers();
    }
  });
});
