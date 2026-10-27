import "./process-reaper.test-support.js";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { runExec } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_ACPX_LEASE_ID_ARG, OPENCLAW_GATEWAY_INSTANCE_ID_ARG } from "./process-lease.js";
import {
  cleanupOpenClawOwnedAcpxPendingLease,
  cleanupOpenClawOwnedAcpxProcessTree,
  reapStaleOpenClawOwnedAcpxOrphans,
} from "./process-reaper.js";
const { mockAcpxProcessSystem } = await import("./process-reaper.test-support.js");
type AcpxProcessSystemFixture = import("./process-reaper.test-support.js").AcpxProcessSystemFixture;

const WRAPPER_ROOT = "/tmp/owner's state/acpx";
const CODEX_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/codex-acp-wrapper.mjs`;
const CODEX_WRAPPER_COMMAND_WITH_LEASE = `${CODEX_WRAPPER_COMMAND} --label owner's-choice ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`;
const runExecMock = vi.mocked(runExec);

it.each(["inspection", "grace"])(
  "revalidates cleanup ownership after awaited %s",
  async (phase) => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let active = true;
    const killProcess = vi.fn();
    mockAcpxProcessSystem({
      killProcess,
      listProcesses: async () => {
        if (phase === "inspection") {
          entered.resolve();
          await release.promise;
        }
        return [{ pid: 101, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE }];
      },
      sleep: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const pending = cleanupOpenClawOwnedAcpxProcessTree({
      rootPid: 101,
      wrapperRoot: WRAPPER_ROOT,
      assertCurrent: () => {
        if (!active) {
          throw new Error("cleanup owner closed");
        }
      },
    });
    const rejected = expect(pending).rejects.toThrow("cleanup owner closed");
    await entered.promise;
    active = false;
    release.resolve();
    await rejected;
    expect(killProcess).toHaveBeenCalledTimes(phase === "grace" ? 1 : 0);
    expect(killProcess).not.toHaveBeenCalledWith(101, "SIGKILL");
  },
);
const CLAUDE_WRAPPER_COMMAND = `node ${WRAPPER_ROOT}/claude-agent-acp-wrapper.mjs`;
const PLUGIN_DEPS_CODEX_COMMAND =
  "node /tmp/openclaw/plugin-runtime-deps/node_modules/@agentclientprotocol/codex-acp/dist/index.js";
const PLUGIN_DEPS_CODEX_APP_SERVER_COMMAND =
  "node /tmp/openclaw/plugin-runtime-deps/node_modules/@openai/codex/bin/codex.js app-server";
const PLUGIN_DEPS_CODEX_PLATFORM_COMMAND =
  "/tmp/openclaw/plugin-runtime-deps/node_modules/@openai/codex-linux-x64/vendor/codex app-server";
const LOCAL_NODE_MODULES_CODEX_COMMAND = `node ${path.resolve(
  "node_modules/@agentclientprotocol/codex-acp/dist/index.js",
)}`;
const LOCAL_CODEX_APP_SERVER_COMMAND = `node ${path.resolve(
  "node_modules/@openai/codex/bin/codex.js",
)} app-server`;
// Legacy adapter subprocesses remain cleanup-owned during upgrades.
const LOCAL_NODE_MODULES_CODEX_PLATFORM_COMMAND = path.resolve(
  "node_modules/@zed-industries/codex-acp-linux-x64/bin/codex-acp",
);

type AcpxProcessInfo = Awaited<
  ReturnType<NonNullable<AcpxProcessSystemFixture["listProcesses"]>>
>[number];

function cleanupDeps(processes: AcpxProcessInfo[]) {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  mockAcpxProcessSystem({
    listProcesses: async () => processes,
    killProcess: (pid: number, signal: NodeJS.Signals) => {
      killed.push({ pid, signal });
    },
  });
  return { killed };
}

function cleanupTree(
  rootPid: number,
  overrides: Parameters<typeof cleanupOpenClawOwnedAcpxProcessTree>[0] = {},
) {
  return cleanupOpenClawOwnedAcpxProcessTree({
    rootPid,
    rootCommand: CODEX_WRAPPER_COMMAND,
    wrapperRoot: WRAPPER_ROOT,
    ...overrides,
  });
}

function cleanupPendingLease() {
  return cleanupOpenClawOwnedAcpxPendingLease({
    leaseId: "lease-1",
    gatewayInstanceId: "gateway-1",
    wrapperRoot: WRAPPER_ROOT,
    wrapperPath: `${WRAPPER_ROOT}/codex-acp-wrapper.mjs`,
  });
}

function skippedResult(skippedReason: string) {
  return { terminatedPids: [], skippedReason };
}

describe("process reaper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runExecMock.mockReset();
  });

  it("bounds process inspection and fails closed on timeout", async () => {
    runExecMock.mockRejectedValueOnce(new Error("process listing timed out"));
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const killSpy = vi.spyOn(process, "kill");
    const result = await cleanupTree(200);
    expect(runExecMock).toHaveBeenCalledWith("ps", ["-axo", "pid=,ppid=,command="], {
      logOutput: false,
      maxBuffer: 8 * 1024 * 1024,
      timeoutMs: 2_000,
    });
    expect(result).toEqual(skippedResult("process-list-unavailable"));
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("requires matching lease identity before killing a leased process tree", async () => {
    const { killed } = cleanupDeps([
      { pid: 112, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
    ]);
    const result = await cleanupTree(112, {
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
    });
    expect(result.skippedReason).toBeUndefined();
    expect(killed[0]).toEqual({ pid: 112, signal: "SIGTERM" });
  });

  it("does not kill a reused same-root wrapper pid with a different lease identity", async () => {
    const { killed } = cleanupDeps([
      {
        pid: 113,
        ppid: 1,
        command: `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} other-lease ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-1`,
      },
    ]);
    const result = await cleanupTree(113, {
      expectedLeaseId: "lease-1",
      expectedGatewayInstanceId: "gateway-1",
    });
    expect(result).toEqual(skippedResult("not-openclaw-owned"));
    expect(killed).toStrictEqual([]);
  });

  it("recovers a pending lease only from its exact wrapper and gateway identity", async () => {
    const { killed } = cleanupDeps([
      { pid: 119, ppid: 1, command: "node /tmp/owner's-unrelated-script.mjs" },
      { pid: 120, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
      {
        pid: 121,
        ppid: 1,
        command: `${CODEX_WRAPPER_COMMAND} ${OPENCLAW_ACPX_LEASE_ID_ARG} lease-1 ${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-foreign`,
      },
      { pid: 122, ppid: 120, command: "node adapter-child.js" },
    ]);
    const result = await cleanupPendingLease();
    expect(result.skippedReason).toBeUndefined();
    expect(killed.slice(0, 2)).toEqual([
      { pid: 122, signal: "SIGTERM" },
      { pid: 120, signal: "SIGTERM" },
    ]);
    expect(killed.some((entry) => entry.pid === 121)).toBe(false);
  });

  it("fails closed when pending lease evidence is ambiguous or unavailable", async () => {
    const { killed } = cleanupDeps([
      { pid: 130, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
      { pid: 131, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
    ]);
    await expect(cleanupPendingLease()).resolves.toEqual(skippedResult("ambiguous-root"));
    expect(killed).toEqual([]);
    runExecMock.mockRejectedValueOnce(new Error("ps unavailable"));
    await expect(cleanupPendingLease()).resolves.toMatchObject({
      skippedReason: "process-list-unavailable",
    });
  });

  it("keeps pending leases untouched when process evidence is unsupported", async () => {
    const listProcesses = vi.fn(async () => [
      { pid: 140, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
    ]);
    const killProcess = vi.fn();
    mockAcpxProcessSystem({ platform: "win32", listProcesses, killProcess });
    await expect(cleanupPendingLease()).resolves.toEqual(skippedResult("unsupported-platform"));
    expect(listProcesses).not.toHaveBeenCalled();
    expect(killProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["unrelated reused pid", "node unrelated.js", CODEX_WRAPPER_COMMAND],
    ["adapter replacing a wrapper", PLUGIN_DEPS_CODEX_COMMAND, CODEX_WRAPPER_COMMAND],
    ["non-owned recorded tree", "node server.js", "node server.js"],
  ])("does not kill %s", async (_name, command, rootCommand) => {
    const { killed } = cleanupDeps([{ pid: 250, ppid: 1, command }]);
    await expect(cleanupTree(250, { rootCommand })).resolves.toEqual(
      skippedResult("not-openclaw-owned"),
    );
    expect(killed).toStrictEqual([]);
  });

  it("reaps owned wrapper and packaged/local adapter trees without claiming native or leased processes", async () => {
    const { killed } = cleanupDeps([
      { pid: 400, ppid: 1, command: CODEX_WRAPPER_COMMAND },
      { pid: 401, ppid: 400, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 402, ppid: 401, command: "node child.js" },
      { pid: 403, ppid: 1, command: CLAUDE_WRAPPER_COMMAND },
      { pid: 404, ppid: 403, command: "node claude-child.js" },
      { pid: 405, ppid: 1, command: PLUGIN_DEPS_CODEX_COMMAND },
      { pid: 406, ppid: 1, command: "node /tmp/other/codex-acp-wrapper.mjs" },
      { pid: 407, ppid: 1, command: CODEX_WRAPPER_COMMAND_WITH_LEASE },
      { pid: 408, ppid: 1, command: "node /tmp/owner's-unrelated-script.mjs" },
      { pid: 500, ppid: 1, command: LOCAL_NODE_MODULES_CODEX_COMMAND },
      { pid: 501, ppid: 500, command: LOCAL_NODE_MODULES_CODEX_PLATFORM_COMMAND },
      { pid: 510, ppid: 1, command: PLUGIN_DEPS_CODEX_APP_SERVER_COMMAND },
      { pid: 511, ppid: 510, command: PLUGIN_DEPS_CODEX_PLATFORM_COMMAND },
      { pid: 512, ppid: 1, command: LOCAL_CODEX_APP_SERVER_COMMAND },
    ]);
    const result = await reapStaleOpenClawOwnedAcpxOrphans({ wrapperRoot: WRAPPER_ROOT });
    expect(result.skippedReason).toBeUndefined();
    expect(killed.filter((entry) => entry.signal === "SIGTERM").map((entry) => entry.pid)).toEqual([
      402, 401, 400, 404, 403, 405, 501, 500, 511, 510,
    ]);
  });

  it("keeps startup scans quiet when process listing is unavailable", async () => {
    mockAcpxProcessSystem();
    runExecMock.mockRejectedValueOnce(new Error("ps unavailable"));
    const result = await reapStaleOpenClawOwnedAcpxOrphans({ wrapperRoot: WRAPPER_ROOT });
    expect(result).toEqual(skippedResult("process-list-unavailable"));
  });
});
