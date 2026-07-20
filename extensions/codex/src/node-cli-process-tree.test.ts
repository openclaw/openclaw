import type { ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { signalCodexResumeProcessTree } from "./node-cli-process-tree.js";

type CodexResumeProcessTreeRuntime = NonNullable<
  Parameters<typeof signalCodexResumeProcessTree>[2]
>;

function createChild(pid = 4321) {
  return {
    pid,
    kill: vi.fn(() => true),
  } as Pick<ChildProcess, "kill" | "pid">;
}

function createRuntime(platform: NodeJS.Platform = "win32") {
  const once = vi.fn();
  const taskkillKill = vi.fn(() => true);
  const unref = vi.fn();
  const spawnTaskkill = vi.fn(() => ({
    kill: taskkillKill,
    once,
    unref,
  })) as unknown as typeof spawn;
  return {
    once,
    runtime: {
      platform,
      spawn: spawnTaskkill,
      taskkillPath: "C:\\Windows\\System32\\taskkill.exe",
    } satisfies CodexResumeProcessTreeRuntime,
    spawnTaskkill,
    taskkillKill,
    unref,
  };
}

describe("signalCodexResumeProcessTree", () => {
  it.each([
    ["SIGTERM", ["/F", "/T", "/PID", "4321"]],
    ["SIGKILL", ["/F", "/T", "/PID", "4321"]],
  ] as const)("uses taskkill for Windows %s signals", (signal, expectedArgs) => {
    const child = createChild();
    const { once, runtime, spawnTaskkill, unref } = createRuntime();

    signalCodexResumeProcessTree(child, signal, runtime);

    expect(spawnTaskkill).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      [...expectedArgs],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    expect(once).toHaveBeenCalledWith("error", expect.any(Function));
    expect(once).toHaveBeenCalledWith("close", expect.any(Function));
    expect(unref).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back to the direct child signal when taskkill cannot start", () => {
    const child = createChild();
    const spawnTaskkill = vi.fn(() => {
      throw new Error("missing taskkill");
    }) as unknown as typeof spawn;

    signalCodexResumeProcessTree(child, "SIGKILL", {
      platform: "win32",
      spawn: spawnTaskkill,
      taskkillPath: "C:\\Windows\\System32\\taskkill.exe",
    });

    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back when taskkill emits a spawn error", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    signalCodexResumeProcessTree(child, "SIGTERM", runtime);
    const errorHandler = once.mock.calls[0]?.[1] as ((error: Error) => void) | undefined;
    expect(errorHandler).toEqual(expect.any(Function));
    errorHandler?.(new Error("missing taskkill"));

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("falls back when taskkill exits unsuccessfully", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    signalCodexResumeProcessTree(child, "SIGTERM", runtime);
    const closeHandler = once.mock.calls.find(([event]) => event === "close")?.[1] as
      | ((code: number | null) => void)
      | undefined;
    expect(closeHandler).toEqual(expect.any(Function));
    closeHandler?.(1);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not fall back after taskkill exits successfully", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    signalCodexResumeProcessTree(child, "SIGTERM", runtime);
    const closeHandler = once.mock.calls.find(([event]) => event === "close")?.[1] as
      | ((code: number | null) => void)
      | undefined;
    closeHandler?.(0);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("bounds a stalled taskkill before falling back", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { runtime, taskkillKill, unref } = createRuntime();

      signalCodexResumeProcessTree(child, "SIGTERM", runtime);
      vi.advanceTimersByTime(5_000);

      expect(taskkillKill).toHaveBeenCalledWith("SIGKILL");
      expect(unref).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  it("signals the direct child outside Windows", () => {
    const child = createChild();
    const { runtime, spawnTaskkill } = createRuntime("linux");

    signalCodexResumeProcessTree(child, "SIGTERM", runtime);

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawnTaskkill).not.toHaveBeenCalled();
  });
});
