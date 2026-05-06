import { describe, expect, it, vi } from "vitest";
import {
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawOwnedAcpxProcess,
  parsePsProcessList,
  reapStaleOpenClawOwnedAcpxOrphans,
} from "./process-reaper.js";

describe("OpenClaw-owned acpx process reaper", () => {
  it("parses ps output without losing command arguments", () => {
    expect(
      parsePsProcessList(`
        101     1 /usr/bin/node /tmp/openclaw/acpx/codex-acp-wrapper.mjs -c model=gpt-5.4
        102   101 /usr/bin/node /Users/me/.openclaw/plugin-runtime-deps/openclaw/node_modules/@zed-industries/codex-acp/bin/codex-acp.js
      `),
    ).toEqual([
      {
        pid: 101,
        ppid: 1,
        command: "/usr/bin/node /tmp/openclaw/acpx/codex-acp-wrapper.mjs -c model=gpt-5.4",
      },
      {
        pid: 102,
        ppid: 101,
        command:
          "/usr/bin/node /Users/me/.openclaw/plugin-runtime-deps/openclaw/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      },
    ]);
  });

  it("recognizes only OpenClaw acpx wrapper and plugin-runtime-deps Codex ACP processes", () => {
    expect(
      isOpenClawOwnedAcpxProcess({
        pid: 101,
        ppid: 1,
        command: "/usr/bin/node /Users/me/.openclaw/state/acpx/codex-acp-wrapper.mjs",
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcess({
        pid: 102,
        ppid: 1,
        command:
          "/usr/bin/node /Users/me/.openclaw/plugin-runtime-deps/openclaw/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcess({
        pid: 103,
        ppid: 1,
        command: "/usr/local/bin/codex app-server --port 12345",
      }),
    ).toBe(false);
    expect(
      isOpenClawOwnedAcpxProcess({
        pid: 104,
        ppid: 1,
        command: "/usr/local/bin/codex exec --model gpt-5.4",
      }),
    ).toBe(false);
  });

  it("cleans stale PPID=1 OpenClaw-owned acpx orphans and their descendants", async () => {
    const killed: Array<[number, NodeJS.Signals]> = [];

    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      listProcesses: async () => [
        {
          pid: 101,
          ppid: 1,
          command: "/usr/bin/node /Users/me/.openclaw/state/acpx/codex-acp-wrapper.mjs",
        },
        {
          pid: 102,
          ppid: 101,
          command: "/bin/sh -c codex-acp",
        },
        {
          pid: 201,
          ppid: 1,
          command: "/usr/local/bin/codex app-server --port 12345",
        },
      ],
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      isProcessAlive: () => false,
      sleep: async () => {},
      forceAfterMs: 0,
    });

    expect(result.killedPids).toEqual([102, 101]);
    expect(killed).toEqual([
      [102, "SIGTERM"],
      [101, "SIGTERM"],
    ]);
  });

  it("uses stateDir to avoid reaping unrelated orphaned acpx wrappers at startup", async () => {
    const killed: number[] = [];

    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      stateDir: "/Users/me/.openclaw/state",
      listProcesses: async () => [
        {
          pid: 101,
          ppid: 1,
          command: "/usr/bin/node /Users/me/.openclaw/state/acpx/codex-acp-wrapper.mjs",
        },
        {
          pid: 201,
          ppid: 1,
          command: "/usr/bin/node /tmp/other/acpx/codex-acp-wrapper.mjs",
        },
      ],
      killProcess: (pid) => {
        killed.push(pid);
      },
      isProcessAlive: () => false,
      sleep: async () => {},
      forceAfterMs: 0,
    });

    expect(result.killedPids).toEqual([101]);
    expect(killed).toEqual([101]);
  });

  it("cleans a normal OpenClaw-owned process tree from a recorded root pid", async () => {
    const killed: Array<[number, NodeJS.Signals]> = [];
    const processes = [
      {
        pid: 301,
        ppid: 77,
        command: "/usr/bin/node /Users/me/.openclaw/state/acpx/codex-acp-wrapper.mjs",
      },
      {
        pid: 302,
        ppid: 301,
        command:
          "/usr/bin/node /Users/me/.openclaw/plugin-runtime-deps/openclaw/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      },
      {
        pid: 303,
        ppid: 302,
        command: "/bin/sh -c helper",
      },
    ];

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 301,
      rootCommand: processes[0]?.command,
      processes,
      killProcess: (pid, signal) => {
        killed.push([pid, signal]);
      },
      isProcessAlive: () => false,
      sleep: async () => {},
      forceAfterMs: 0,
    });

    expect(result.killedPids).toEqual([303, 302, 301]);
    expect(killed.map(([pid]) => pid)).toEqual([303, 302, 301]);
  });

  it("refuses to clean a recorded tree whose root is not OpenClaw-owned", async () => {
    const killProcess = vi.fn();

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 401,
      rootCommand: "/usr/local/bin/codex app-server --port 12345",
      processes: [
        {
          pid: 401,
          ppid: 1,
          command: "/usr/local/bin/codex app-server --port 12345",
        },
        {
          pid: 402,
          ppid: 401,
          command: "/bin/sh -c child",
        },
      ],
      killProcess,
    });

    expect(result.killedPids).toEqual([]);
    expect(killProcess).not.toHaveBeenCalled();
  });
});
