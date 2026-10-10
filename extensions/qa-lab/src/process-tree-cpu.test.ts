// Qa Lab tests cover POSIX process tree metric sampling.
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: readFileSyncMock };
});

import { readProcessTreeCpuMs, readProcessTreeRssBytes } from "./process-tree-cpu.js";

afterEach(() => {
  vi.restoreAllMocks();
  spawnSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

function usePsOutput(stdout: string, platform: NodeJS.Platform = "linux"): void {
  vi.spyOn(process, "platform", "get").mockReturnValue(platform);
  spawnSyncMock.mockReturnValue({ status: 0, stdout });
}

describe("POSIX process tree metrics", () => {
  it("parses ps CPU time formats", () => {
    usePsOutput(
      [
        "100 0 00:01",
        "101 0 00:00.12",
        "102 0 01:02",
        "103 0 01:02:03.45",
        "104 0 1-02:03:04.5",
      ].join("\n"),
    );

    expect(readProcessTreeCpuMs(100)).toBe(1_000);
    expect(readProcessTreeCpuMs(101)).toBe(120);
    expect(readProcessTreeCpuMs(102)).toBe(62_000);
    expect(readProcessTreeCpuMs(103)).toBe(3_723_450);
    expect(readProcessTreeCpuMs(104)).toBe(93_784_500);
    expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid=,time="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects malformed ps CPU time strings", () => {
    usePsOutput(
      [
        "101 0 nope",
        "102 0 1::02",
        "103 0 1-02:03",
        "104 0 01:60",
        "105 0 01:02:60",
        "106 0 1:2:3:4",
      ].join("\n"),
    );

    expect(readProcessTreeCpuMs(100)).toBeNull();
    expect(readProcessTreeCpuMs(101)).toBeNull();
    expect(readProcessTreeCpuMs(102)).toBeNull();
    expect(readProcessTreeCpuMs(103)).toBeNull();
    expect(readProcessTreeCpuMs(104)).toBeNull();
    expect(readProcessTreeCpuMs(105)).toBeNull();
    expect(readProcessTreeCpuMs(106)).toBeNull();
  });

  it("parses macOS ps RSS KiB values as bytes", () => {
    usePsOutput(["100 0 1024", "101 0 1.5"].join("\n"), "darwin");

    expect(readProcessTreeRssBytes(100)).toBe(1_048_576);
    expect(readProcessTreeRssBytes(101)).toBe(1_536);
    expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-eo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
  });

  it("rejects malformed macOS ps RSS values", () => {
    usePsOutput(["101 0 nope", "102 0 -1", "103 0 0x10"].join("\n"), "darwin");

    expect(readProcessTreeRssBytes(100)).toBeNull();
    expect(readProcessTreeRssBytes(101)).toBeNull();
    expect(readProcessTreeRssBytes(102)).toBeNull();
    expect(readProcessTreeRssBytes(103)).toBeNull();
  });
});

describe("Linux process tree RSS", () => {
  it("sums explicit VmRSS for the root and descendants without reading unrelated processes", () => {
    usePsOutput(["100 0 0", "101 100 0", "102 101 0", "200 0 0"].join("\n"));
    const statuses: Record<string, string> = {
      "/proc/100/status": "VmRSS:\t1024 kB\n",
      "/proc/101/status": "VmRSS:\t2048 kB\n",
      "/proc/102/status": "VmRSS:\t0 kB\n",
    };
    readFileSyncMock.mockImplementation((path: string) => {
      const status = statuses[path];
      if (status === undefined) {
        throw new Error("unexpected process read");
      }
      return status;
    });

    expect(readProcessTreeRssBytes(100)).toBe(3 * 1024 * 1024);
    expect(readFileSyncMock.mock.calls.map(([path]) => path)).toEqual([
      "/proc/100/status",
      "/proc/101/status",
      "/proc/102/status",
    ]);
    expect(readProcessTreeRssBytes(102)).toBe(0);
  });

  it("reports unavailable RSS when a zombie leader still has live threads", () => {
    usePsOutput("100 0 0");
    readFileSyncMock.mockReturnValue("State:\tZ (zombie)\nThreads:\t2\n");

    expect(readProcessTreeRssBytes(100)).toBeNull();
  });

  it.each(["100 0 0\n101 100 0", "100 0 0\n101 100 nope", "100 0 0\n101 100"])(
    "keeps unavailable child memory in the tree: %s",
    (stdout) => {
      usePsOutput(stdout);
      readFileSyncMock.mockImplementation((path: string) =>
        path === "/proc/100/status" ? "VmRSS:\t1024 kB\n" : "Threads:\t2\n",
      );

      expect(readProcessTreeRssBytes(100)).toBeNull();
      expect(readFileSyncMock).toHaveBeenCalledWith("/proc/101/status", "utf8");
    },
  );

  it("keeps descendants when ps omits an intermediate metric", () => {
    usePsOutput("100 0 0\n101 100\n102 101 0");
    readFileSyncMock.mockReturnValue("VmRSS:\t1024 kB\n");

    expect(readProcessTreeRssBytes(100)).toBe(3 * 1024 * 1024);
  });

  it.each(["ENOENT", "EACCES"])("reports unreadable process memory as unavailable: %s", (code) => {
    usePsOutput("100 0 0");
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("status unavailable"), { code });
    });

    expect(readProcessTreeRssBytes(100)).toBeNull();
  });

  it.each(["", "VmRSS: -1 kB\n", "VmRSS: 1.5 kB\n", "VmRSS: 0x10 kB\n", "VmRSS: 1 MB\n"])(
    "rejects missing or malformed VmRSS: %s",
    (status) => {
      usePsOutput("100 0 0");
      readFileSyncMock.mockReturnValue(status);

      expect(readProcessTreeRssBytes(100)).toBeNull();
    },
  );

  it("does not read process status when the root is absent from the snapshot", () => {
    usePsOutput("101 0 0");

    expect(readProcessTreeRssBytes(100)).toBeNull();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });
});
