import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: spawnSyncMock };
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

function expectPsCommand(column: string) {
  expect(spawnSyncMock).toHaveBeenCalledWith("ps", ["-eo", `pid=,ppid=,${column}=`], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

describe("POSIX process tree metrics", () => {
  it("parses ps CPU time formats", () => {
    usePsOutput("100 0 00:01\n101 0 00:00.12\n102 0 01:02\n103 0 01:02:03.45\n104 0 1-02:03:04.5");
    expect([100, 101, 102, 103, 104].map(readProcessTreeCpuMs)).toEqual([
      1_000, 120, 62_000, 3_723_450, 93_784_500,
    ]);
    expectPsCommand("time");
  });

  it("rejects malformed ps CPU time strings", () => {
    usePsOutput(
      "101 0 nope\n102 0 1::02\n103 0 1-02:03\n104 0 01:60\n105 0 01:02:60\n106 0 1:2:3:4",
    );
    for (const pid of [100, 101, 102, 103, 104, 105, 106]) {
      expect(readProcessTreeCpuMs(pid)).toBeNull();
    }
  });

  it("parses macOS ps RSS KiB values as bytes", () => {
    usePsOutput("100 0 1024\n101 0 1.5", "darwin");
    expect([100, 101].map(readProcessTreeRssBytes)).toEqual([1_048_576, 1_536]);
    expectPsCommand("rss");
  });

  it("rejects malformed macOS ps RSS values", () => {
    usePsOutput("101 0 nope\n102 0 -1\n103 0 0x10", "darwin");
    expect([100, 101, 102, 103].map(readProcessTreeRssBytes)).toEqual([null, null, null, null]);
  });
  it("reports unavailable RSS when a zombie leader still has live threads", () => {
    usePsOutput("100 0 0");
    readFileSyncMock.mockReturnValue("State:\tZ (zombie)\nThreads:\t2\n");

    expect(readProcessTreeRssBytes(100)).toBeNull();
  });

  it("keeps unavailable child memory in the tree", () => {
    usePsOutput("100 0 0\n101 100");
    readFileSyncMock.mockImplementation((path: string) =>
      path === "/proc/100/status" ? "VmRSS:\t1024 kB\n" : "Threads:\t2\n",
    );

    expect(readProcessTreeRssBytes(100)).toBeNull();
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/101/status", "utf8");
  });

  it("reports unreadable process memory as unavailable", () => {
    usePsOutput("100 0 0");
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("status unavailable"), { code: "ENOENT" });
    });

    expect(readProcessTreeRssBytes(100)).toBeNull();
  });
});
