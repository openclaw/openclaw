// ACPX tests cover process reaper plugin behavior.
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_ACPX_LEASE_ID_ENV,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ENV,
} from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxProcessTree,
  isOpenClawLeaseAwareAcpxProcessCommand,
  isOpenClawOwnedAcpxProcessCommand,
  reapStaleOpenClawOwnedAcpxOrphans,
  testing,
  type AcpxProcessInfo,
} from "./process-reaper.js";

const WRAPPER_ROOT = "/tmp/openclaw-state/acpx";
const CODEX_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/codex-acp-wrapper.mjs`;
const CODEX_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`;
const CLAUDE_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/claude-agent-acp-wrapper.mjs`;
const LEASE_ENV = `${OPENCLAW_ACPX_LEASE_ID_ENV}=lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=gateway-1`;
const PLUGIN_DEPS_CODEX_COMMAND =
  "node /tmp/openclaw/plugin-runtime-deps/node_modules/@zed-industries/codex-acp/bin/codex-acp.js";
const LOCAL_NODE_MODULES_CODEX_COMMAND = `node ${path.resolve(
  "node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
)}`;
const LOCAL_NODE_MODULES_CODEX_PLATFORM_COMMAND = path.resolve(
  "node_modules/@zed-industries/codex-acp-linux-x64/bin/codex-acp",
);

function cleanupDeps(processes: AcpxProcessInfo[]) {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  return {
    killed,
    deps: {
      listProcesses: vi.fn(async () => processes),
      killProcess: vi.fn((pid: number, signal: NodeJS.Signals) => {
        killed.push({ pid, signal });
      }),
      sleep: vi.fn(async () => {}),
    },
  };
}

function collectMatching<T, U>(
  items: readonly T[],
  predicate: (item: T) => boolean,
  map: (item: T) => U,
): U[] {
  const matches: U[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(map(item));
    }
  }
  return matches;
}

describe("process reaper", () => {
  it("parses Windows process inventory without depending on environment output", () => {
    expect(
      testing.parseWindowsProcessList(
        JSON.stringify([
          {
            ProcessId: 41,
            ParentProcessId: 7,
            CommandLine: '"C:\\Program Files\\node.exe" wrapper.mjs',
            ExecutablePath: "C:\\Program Files\\node.exe",
          },
          {
            ProcessId: 42,
            ParentProcessId: 41,
            CommandLine: null,
            ExecutablePath: "C:\\Windows\\System32\\conhost.exe",
          },
        ]),
      ),
    ).toEqual([
      { pid: 41, ppid: 7, command: '"C:\\Program Files\\node.exe" wrapper.mjs' },
      { pid: 42, ppid: 41, command: "C:\\Windows\\System32\\conhost.exe" },
    ]);
  });

  it("recognizes generated Codex and Claude wrappers only under the configured root", () => {
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: CODEX_WRAPPER_COMMAND,
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: CLAUDE_WRAPPER_COMMAND,
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(true);
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: "node /tmp/other/codex-acp-wrapper.mjs",
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(false);
  });

  it("only treats generated wrappers as launch-lease aware", () => {
    expect(
      isOpenClawLeaseAwareAcpxProcessCommand({
        command: CODEX_WRAPPER_COMMAND,
        wrapperRoot: WRAPPER_ROOT,
      }),
    ).toBe(true);
    expect(
      isOpenClawLeaseAwareAcpxProcessCommand({ command: LOCAL_NODE_MODULES_CODEX_COMMAND }),
    ).toBe(false);
    expect(isOpenClawLeaseAwareAcpxProcessCommand({ command: PLUGIN_DEPS_CODEX_COMMAND })).toBe(
      false,
    );
  });

  it("recognizes OpenClaw plugin-runtime-deps ACP adapter children", () => {
    expect(isOpenClawOwnedAcpxProcessCommand({ command: PLUGIN_DEPS_CODEX_COMMAND })).toBe(true);
    expect(isOpenClawOwnedAcpxProcessCommand({ command: "npx @zed-industries/codex-acp" })).toBe(
      false,
    );
  });

  it("recognizes plugin-local ACP adapter package paths without trusting arbitrary installs", () => {
    expect(isOpenClawOwnedAcpxProcessCommand({ command: LOCAL_NODE_MODULES_CODEX_COMMAND })).toBe(
      true,
    );
    expect(
      isOpenClawOwnedAcpxProcessCommand({
        command: "node /tmp/other-project/node_modules/@zed-industries/codex-acp/bin/codex-acp.js",
      }),
    ).toBe(false);
  });

  it("kills an owned recorded process tree children first", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 100, ppid: 1, command: CODEX_WRAPPER_COMMAND },
      { pid: 101, ppid: 100, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 102, ppid: 101, command: "node child.js" },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 100,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inspectedPids).toEqual([100, 101, 102]);
    expect(killed.slice(0, 3)).toEqual([
      { pid: 102, signal: "SIGTERM" },
      { pid: 101, signal: "SIGTERM" },
      { pid: 100, signal: "SIGTERM" },
    ]);
  });

  it("allows wrapper-root verification when stored wrapper commands are shell-quoted", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 110, ppid: 1, command: CODEX_WRAPPER_COMMAND }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 110,
      rootCommand: `"/usr/local/bin/node" "${WRAPPER_ROOT}/codex-acp-wrapper.mjs"`,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(killed[0]).toEqual({ pid: 110, signal: "SIGTERM" });
  });

  it("requires matching lease identity before killing a leased process tree", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 112, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 112,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(killed[0]).toEqual({ pid: 112, signal: "SIGTERM" });
  });

  it("kills reparented descendants that retain the ACPX lease environment", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 114,
        ppid: 1,
        command: `claude -p --permission-mode bypassPermissions ${LEASE_ENV}`,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 112,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({ inspectedPids: [114], terminatedPids: [114] });
    expect(killed[0]).toEqual({ pid: 114, signal: "SIGTERM" });
  });

  it("combines the live wrapper tree with detached lease descendants", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 115, ppid: 1, command: `${CODEX_WRAPPER_COMMAND_WITH_LEASE} ${LEASE_ENV}` },
      { pid: 116, ppid: 115, command: `node adapter.js ${LEASE_ENV}` },
      { pid: 117, ppid: 1, command: `claude -p ${LEASE_ENV}` },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 115,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.inspectedPids).toEqual([115, 116, 117]);
    expect(
      collectMatching(
        killed,
        (entry) => entry.signal === "SIGTERM",
        (entry) => entry.pid,
      ),
    ).toEqual([117, 116, 115]);
  });

  it("does not trust a lease marker from another gateway instance", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 118,
        ppid: 1,
        command: `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ENV}=lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ENV}=other-gateway`,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 119,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBe("missing-root");
    expect(killed).toStrictEqual([]);
  });

  it("reports owned processes that survive SIGKILL", async () => {
    const { deps: baseDeps } = cleanupDeps([
      { pid: 120, ppid: 1, command: `${CODEX_WRAPPER_COMMAND_WITH_LEASE} ${LEASE_ENV}` },
    ]);
    const deps = { ...baseDeps, isProcessAlive: vi.fn(() => true) };

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 120,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.survivingPids).toEqual([120]);
  });

  it("keeps a live PID in survivor verification when both signal calls fail", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 122,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => [
          { pid: 122, ppid: 1, command: `${CODEX_WRAPPER_COMMAND_WITH_LEASE} ${LEASE_ENV}` },
        ]),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
          throw new Error("signal failed");
        }),
        isProcessAlive: vi.fn(() => true),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(killed).toEqual([
      { pid: 122, signal: "SIGTERM" },
      { pid: 122, signal: "SIGKILL" },
    ]);
    expect(result.terminatedPids).toStrictEqual([]);
    expect(result.survivingPids).toEqual([122]);
  });

  it("does not SIGKILL a PID whose lease identity changes during the TERM grace period", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const ownedProcess = {
      pid: 123,
      ppid: 1,
      command: `${CODEX_WRAPPER_COMMAND_WITH_LEASE} ${LEASE_ENV}`,
    };
    const reusedProcess = {
      pid: 123,
      ppid: 1,
      command: "node unrelated-work.js",
    };
    let inventoryReads = 0;

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 123,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => {
          inventoryReads += 1;
          return inventoryReads === 1 ? [ownedProcess] : [reusedProcess];
        }),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
        }),
        isProcessAlive: vi.fn(() => true),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(killed).toEqual([{ pid: 123, signal: "SIGTERM" }]);
    expect(result.terminatedPids).toEqual([123]);
    expect(result.survivingPids ?? []).toStrictEqual([]);
  });

  it("revalidates a PPID-tree child without environment inventory before escalation", async () => {
    const processes = [
      { pid: 124, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
      { pid: 125, ppid: 124, command: "node adapter.js" },
    ];
    const alive = new Map([
      [124, true],
      [125, true],
    ]);
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 124,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => processes),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
          if (signal === "SIGTERM" && pid === 124) {
            alive.set(pid, false);
          }
          if (signal === "SIGKILL") {
            alive.set(pid, false);
          }
        }),
        isProcessAlive: vi.fn((pid) => alive.get(pid) ?? false),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(killed).toContainEqual({ pid: 125, signal: "SIGKILL" });
    expect(result.survivingPids ?? []).toStrictEqual([]);
  });

  it("reports a drained lease after SIGKILL removes a TERM-resistant process", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    let processAlive = true;
    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 121,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => [
          { pid: 121, ppid: 1, command: `${CODEX_WRAPPER_COMMAND_WITH_LEASE} ${LEASE_ENV}` },
        ]),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
          if (signal === "SIGKILL") {
            processAlive = false;
          }
        }),
        isProcessAlive: vi.fn(() => processAlive),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(killed).toEqual([
      { pid: 121, signal: "SIGTERM" },
      { pid: 121, signal: "SIGKILL" },
    ]);
    expect(result.survivingPids ?? []).toStrictEqual([]);
  });

  it("does not kill a reused same-root wrapper pid with a different lease identity", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 113,
        ppid: 1,
        command: `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} other-lease ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 113,
      rootCommand: CODEX_WRAPPER_COMMAND,
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [113],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toStrictEqual([]);
  });

  it("skips recorded pid cleanup when process listing is unavailable", async () => {
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 200,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => {
          throw new Error("ps unavailable");
        }),
        killProcess: vi.fn((pid, signal) => {
          killed.push({ pid, signal });
        }),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
    expect(killed).toStrictEqual([]);
  });

  it("does not kill a reused pid when the live command is not OpenClaw-owned", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 250, ppid: 1, command: "node unrelated.js" }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 250,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [250],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toStrictEqual([]);
  });

  it("does not kill a reused adapter pid when the stored root was a generated wrapper", async () => {
    const { deps, killed } = cleanupDeps([
      {
        pid: 260,
        ppid: 1,
        command: PLUGIN_DEPS_CODEX_COMMAND,
      },
    ]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 260,
      rootCommand: CODEX_WRAPPER_COMMAND,
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result).toEqual({
      inspectedPids: [260],
      terminatedPids: [],
      skippedReason: "not-openclaw-owned",
    });
    expect(killed).toStrictEqual([]);
  });

  it("skips non-owned recorded process trees", async () => {
    const { deps, killed } = cleanupDeps([{ pid: 300, ppid: 1, command: "node server.js" }]);

    const result = await cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 300,
      rootCommand: "node server.js",
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBe("not-openclaw-owned");
    expect(killed).toStrictEqual([]);
  });

  it("reaps stale OpenClaw-owned wrapper and adapter orphans on startup", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 400, ppid: 1, command: CODEX_WRAPPER_COMMAND },
      { pid: 401, ppid: 400, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 402, ppid: 401, command: "node child.js" },
      { pid: 403, ppid: 1, command: CLAUDE_WRAPPER_COMMAND },
      { pid: 404, ppid: 403, command: "node claude-child.js" },
      { pid: 405, ppid: 1, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 406, ppid: 1, command: "node /tmp/other/codex-acp-wrapper.mjs" },
    ]);

    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inspectedPids).toEqual([400, 401, 402, 403, 404, 405]);
    expect(
      collectMatching(
        killed,
        (entry) => entry.signal === "SIGTERM",
        (entry) => entry.pid,
      ),
    ).toEqual([402, 401, 400, 404, 403, 405]);
  });

  it("reports broad startup reaper survivors after escalation", async () => {
    const processes = [{ pid: 410, ppid: 1, command: CODEX_WRAPPER_COMMAND }];
    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => processes),
        killProcess: vi.fn(),
        isProcessAlive: vi.fn(() => true),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({
      inspectedPids: [410],
      terminatedPids: [],
      survivingPids: [410],
    });
  });

  it("reaps plugin-local Codex ACP adapter orphans when the generated wrapper is already gone", async () => {
    const { deps, killed } = cleanupDeps([
      { pid: 500, ppid: 1, command: LOCAL_NODE_MODULES_CODEX_COMMAND },
      { pid: 501, ppid: 500, command: LOCAL_NODE_MODULES_CODEX_PLATFORM_COMMAND },
    ]);

    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inspectedPids).toEqual([500, 501]);
    expect(
      collectMatching(
        killed,
        (entry) => entry.signal === "SIGTERM",
        (entry) => entry.pid,
      ),
    ).toEqual([501, 500]);
  });

  it("keeps startup scans quiet when process listing is unavailable", async () => {
    const result = await reapStaleOpenClawOwnedAcpxOrphans({
      wrapperRoot: WRAPPER_ROOT,
      deps: {
        listProcesses: vi.fn(async () => {
          throw new Error("ps unavailable");
        }),
        sleep: vi.fn(async () => {}),
      },
    });

    expect(result).toEqual({
      inspectedPids: [],
      terminatedPids: [],
      skippedReason: "process-list-unavailable",
    });
  });
});
