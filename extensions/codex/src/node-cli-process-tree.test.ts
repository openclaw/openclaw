import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { terminateCodexResumeProcess } from "./node-cli-process-tree.js";

type CodexResumeProcessTreeRuntime = NonNullable<Parameters<typeof terminateCodexResumeProcess>[1]>;
type ResumeChildProcess = Parameters<typeof terminateCodexResumeProcess>[0];
type TestResumeChildProcess = Omit<ResumeChildProcess, "exitCode"> &
  EventEmitter & { exitCode: number | null };

function createChild(pid = 4321) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  }) as unknown as TestResumeChildProcess;
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
      env: { SystemRoot: "C:\\Windows" },
    } satisfies CodexResumeProcessTreeRuntime,
    spawnTaskkill,
    taskkillKill,
    unref,
  };
}

describe("signalCodexResumeProcessTree", () => {
  it("resolves taskkill from a trusted Windows system root", () => {
    const child = createChild();
    const systemRootRuntime = createRuntime().runtime;
    const windirRuntime = createRuntime().runtime;

    terminateCodexResumeProcess(child, {
      ...systemRootRuntime,
      env: { SystemRoot: "D:\\Windows\\" },
    });
    terminateCodexResumeProcess(child, {
      ...windirRuntime,
      env: { windir: "E:\\WinNT" },
    });

    expect(systemRootRuntime.spawn).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\taskkill.exe",
      expect.any(Array),
      expect.any(Object),
    );
    expect(windirRuntime.spawn).toHaveBeenCalledWith(
      "E:\\WinNT\\System32\\taskkill.exe",
      expect.any(Array),
      expect.any(Object),
    );
  });

  it.each(["C:\\tmp;C:\\bad", "\\\\server\\Windows", "C:\\", "relative"])(
    "falls back for an unsafe Windows system root: %s",
    (SystemRoot) => {
      const child = createChild();
      const { runtime } = createRuntime();

      terminateCodexResumeProcess(child, {
        ...runtime,
        env: { SystemRoot },
      });

      expect(runtime.spawn).toHaveBeenCalledWith(
        "C:\\Windows\\System32\\taskkill.exe",
        expect.any(Array),
        expect.any(Object),
      );
    },
  );

  it("uses taskkill for Windows timeout termination", () => {
    const child = createChild();
    const { once, runtime, spawnTaskkill, unref } = createRuntime();

    terminateCodexResumeProcess(child, runtime);

    expect(spawnTaskkill).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\taskkill.exe",
      ["/F", "/T", "/PID", "4321"],
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

  it("retries tree termination before direct fallback when taskkill cannot start", () => {
    const child = createChild();
    const spawnTaskkill = vi.fn(() => {
      throw new Error("missing taskkill");
    }) as unknown as typeof spawn;

    terminateCodexResumeProcess(child, {
      platform: "win32",
      spawn: spawnTaskkill,
      env: { SystemRoot: "C:\\Windows" },
    });

    expect(spawnTaskkill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("falls back when taskkill emits a spawn error", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    terminateCodexResumeProcess(child, runtime);
    const errorHandler = once.mock.calls[0]?.[1] as ((error: Error) => void) | undefined;
    expect(errorHandler).toEqual(expect.any(Function));
    errorHandler?.(new Error("missing taskkill"));

    expect(runtime.spawn).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("falls back when taskkill exits unsuccessfully", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    terminateCodexResumeProcess(child, runtime);
    const closeHandler = once.mock.calls.find(([event]) => event === "close")?.[1] as
      | ((code: number | null) => void)
      | undefined;
    expect(closeHandler).toEqual(expect.any(Function));
    closeHandler?.(1);

    expect(runtime.spawn).toHaveBeenCalledTimes(2);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not fall back after taskkill exits successfully", () => {
    const child = createChild();
    const { once, runtime } = createRuntime();

    terminateCodexResumeProcess(child, runtime);
    const closeHandler = once.mock.calls.find(([event]) => event === "close")?.[1] as
      | ((code: number | null) => void)
      | undefined;
    closeHandler?.(0);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it("retries tree termination when the first taskkill stalls", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { runtime, taskkillKill, unref } = createRuntime();

      terminateCodexResumeProcess(child, runtime);
      vi.advanceTimersByTime(1_000);

      expect(taskkillKill).toHaveBeenCalledWith("SIGKILL");
      expect(unref).toHaveBeenCalledOnce();
      expect(runtime.spawn).toHaveBeenCalledTimes(2);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds two stalled tree attempts before direct fallback", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { runtime, taskkillKill, unref } = createRuntime();

      terminateCodexResumeProcess(child, runtime);
      vi.advanceTimersByTime(2_000);

      expect(runtime.spawn).toHaveBeenCalledTimes(2);
      expect(taskkillKill).toHaveBeenCalledTimes(2);
      expect(unref).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the active taskkill finish after it causes the original child to exit", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { once, runtime, taskkillKill, unref } = createRuntime();

      terminateCodexResumeProcess(child, runtime);
      child.exitCode = 0;
      child.emit("exit", 0, null);
      const closeHandler = once.mock.calls.find(([event]) => event === "close")?.[1] as
        | ((code: number | null) => void)
        | undefined;
      closeHandler?.(0);
      vi.advanceTimersByTime(2_000);

      expect(runtime.spawn).toHaveBeenCalledOnce();
      expect(taskkillKill).not.toHaveBeenCalled();
      expect(unref).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a stalled active helper without retrying after the original child exits", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { runtime, taskkillKill, unref } = createRuntime();

      terminateCodexResumeProcess(child, runtime);
      child.exitCode = 0;
      child.emit("exit", 0, null);
      vi.advanceTimersByTime(1_000);

      expect(runtime.spawn).toHaveBeenCalledOnce();
      expect(taskkillKill).toHaveBeenCalledOnce();
      expect(taskkillKill).toHaveBeenCalledWith("SIGKILL");
      expect(unref).toHaveBeenCalledOnce();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the two-stage direct-child termination outside Windows", () => {
    vi.useFakeTimers();
    try {
      const child = createChild();
      const { runtime, spawnTaskkill } = createRuntime("linux");

      terminateCodexResumeProcess(child, runtime);

      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnTaskkill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses two-stage direct-child termination when Windows has no PID", () => {
    vi.useFakeTimers();
    try {
      const child = {
        pid: undefined,
        exitCode: null,
        kill: vi.fn(() => true),
        once: vi.fn(),
        off: vi.fn(),
      } as unknown as ResumeChildProcess;
      const { runtime, spawnTaskkill } = createRuntime();

      terminateCodexResumeProcess(child, runtime);

      expect(child.kill).toHaveBeenCalledOnce();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(spawnTaskkill).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(child.kill).toHaveBeenCalledTimes(2);
      expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });
});
