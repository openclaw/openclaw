import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  isPathOwnedByAnotherRegisteredAgent,
  normalizeAgentDirRegistryPath,
  registerResolvedAgentDir,
  resolveRegisteredAgentIdForDir,
  unregisterResolvedAgentDir,
} from "./agent-dir-registry.js";

vi.mock("node:worker_threads", () => ({ isMainThread: true }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent directory registry", () => {
  it("unregisters only the requested owner", () => {
    const agentDir = path.join("/tmp", `openclaw-agent-dir-registry-${process.pid}`);
    registerResolvedAgentDir({ agentId: "first", agentDir });
    registerResolvedAgentDir({ agentId: "second", agentDir });

    expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
    expect(unregisterResolvedAgentDir({ agentId: "first", agentDir })).toBe(true);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("second");
    expect(unregisterResolvedAgentDir({ agentId: "second", agentDir })).toBe(true);
    expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
  });

  it("detects registered ownership on either side of a cleanup boundary", () => {
    const root = path.join("/tmp", `openclaw-agent-dir-overlap-${process.pid}`);
    const agentDir = path.join(root, "agent");
    registerResolvedAgentDir({ agentId: "current", agentDir });

    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "deleted",
        pathname: root,
      }),
    ).toBe(true);
    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "deleted",
        pathname: path.join(agentDir, "openclaw-agent.sqlite"),
      }),
    ).toBe(true);
    expect(
      isPathOwnedByAnotherRegisteredAgent({
        agentId: "current",
        pathname: root,
      }),
    ).toBe(false);

    unregisterResolvedAgentDir({ agentId: "current", agentDir });
  });

  it("keeps ownership stable through a symlinked parent after the agent dir is removed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-dir-registry-"));
    const realRoot = path.join(root, "real");
    const linkedRoot = path.join(root, "linked");
    const realAgentDir = path.join(realRoot, "agent");
    const linkedAgentDir = path.join(linkedRoot, "agent");
    fs.mkdirSync(realAgentDir, { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    try {
      registerResolvedAgentDir({ agentId: "current", agentDir: realAgentDir });
      expect(resolveRegisteredAgentIdForDir(linkedAgentDir)).toBe("current");
      registerResolvedAgentDir({ agentId: "deleted", agentDir: linkedAgentDir });
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBeUndefined();
      expect(
        isPathOwnedByAnotherRegisteredAgent({
          agentId: "deleted",
          pathname: linkedAgentDir,
        }),
      ).toBe(true);
      expect(unregisterResolvedAgentDir({ agentId: "deleted", agentDir: linkedAgentDir })).toBe(
        true,
      );
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBe("current");

      fs.rmSync(realAgentDir, { recursive: true });
      expect(unregisterResolvedAgentDir({ agentId: "current", agentDir: linkedAgentDir })).toBe(
        true,
      );
      expect(resolveRegisteredAgentIdForDir(realAgentDir)).toBeUndefined();
    } finally {
      unregisterResolvedAgentDir({ agentId: "current", agentDir: linkedAgentDir });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("matches tilde paths against the effective custom home", () => {
    const root = tempDirs.make("openclaw-agent-dir-home-");
    const customHome = path.join(root, "home");
    const agentDir = path.join(customHome, "agents", "main", "agent");
    const env = { HOME: customHome, OPENCLAW_HOME: customHome };
    fs.mkdirSync(customHome, { recursive: true });

    try {
      registerResolvedAgentDir({
        agentId: "main",
        agentDir: "~/agents/main/agent",
        env,
      });
      expect(resolveRegisteredAgentIdForDir(agentDir, env)).toBe("main");
    } finally {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
    }
  });

  it("reuses prepared directory identity for repeated registration and reverse lookup", () => {
    const agentDir = tempDirs.make("openclaw-agent-dir-prepared-");
    registerResolvedAgentDir({ agentId: "main", agentDir });
    const realpath = vi.spyOn(fs.realpathSync, "native");
    try {
      for (let i = 0; i < 10; i++) {
        expect(registerResolvedAgentDir({ agentId: "main", agentDir })).toBe(false);
        expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("main");
      }
      expect(realpath).not.toHaveBeenCalled();
      // Destructive admission callers still request a current physical path.
      expect(normalizeAgentDirRegistryPath(agentDir)).toBe(fs.realpathSync.native(agentDir));
      expect(realpath).toHaveBeenCalled();
    } finally {
      realpath.mockRestore();
      unregisterResolvedAgentDir({ agentId: "main", agentDir });
    }
  });

  it("retains ancestor watches when a named notification leaves directory identity unchanged", () => {
    const agentDir = tempDirs.make("openclaw-agent-dir-unchanged-");
    const watch = vi.spyOn(fs, "watch");
    registerResolvedAgentDir({ agentId: "main", agentDir });
    const count = watch.mock.calls.length;
    const parentIndex = watch.mock.calls.findIndex(
      ([directory]) => directory === path.dirname(agentDir),
    );
    const parent = watch.mock.results[parentIndex];
    if (parent?.type !== "return") {
      throw new Error("Missing agent directory ancestor watch");
    }
    const close = vi.spyOn(parent.value, "close");
    try {
      parent.value.emit("change", "change", path.basename(agentDir));
      expect(close).not.toHaveBeenCalled();
      expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("main");
      expect(watch).toHaveBeenCalledTimes(count);
    } finally {
      close.mockRestore();
      unregisterResolvedAgentDir({ agentId: "main", agentDir });
      watch.mockRestore();
    }
  });

  it("retires ancestor watches on shutdown without losing registered ownership", async () => {
    const agentDir = tempDirs.make("openclaw-agent-dir-shutdown-");
    const watch = vi.spyOn(fs, "watch");
    registerResolvedAgentDir({ agentId: "main", agentDir });
    const closes = watch.mock.results.map((result) => {
      if (result.type !== "return") {
        throw new Error("Missing agent directory ancestor watch");
      }
      return vi.spyOn(result.value, "close");
    });
    try {
      expect(closes.length).toBeGreaterThan(0);
      await drainGlobalSingletonLifecycleState("restart", { retainSharedState: true });
      expect(closes.every((close) => close.mock.calls.length === 0)).toBe(true);
      await drainGlobalSingletonLifecycleState("shared-state");
      expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
      expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("main");
    } finally {
      unregisterResolvedAgentDir({ agentId: "main", agentDir });
      closes.forEach((close) => close.mockRestore());
      watch.mockRestore();
    }
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
    registerResolvedAgentDir({ agentId: "main", agentDir });
    try {
      expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("main");
      fs.unlinkSync(alias);
      fs.symlinkSync(replacement, alias, process.platform === "win32" ? "junction" : "dir");
      expect(unregisterResolvedAgentDir({ agentId: "main", agentDir })).toBe(false);
      expect(isPathOwnedByAnotherRegisteredAgent({ agentId: "other", pathname: original })).toBe(
        true,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(resolveRegisteredAgentIdForDir(agentDir)).toBeUndefined();
      expect(resolveRegisteredAgentIdForDir(path.join(original, "agent"))).toBe("main");
      registerResolvedAgentDir({ agentId: "replacement", agentDir });
      expect(unregisterResolvedAgentDir({ agentId: "main", agentDir })).toBe(false);
      expect(resolveRegisteredAgentIdForDir(agentDir)).toBe("replacement");
    } finally {
      unregisterResolvedAgentDir({ agentId: "replacement", agentDir });
      unregisterResolvedAgentDir({ agentId: "main", agentDir: path.join(original, "agent") });
      vi.useRealTimers();
    }
  });
});
