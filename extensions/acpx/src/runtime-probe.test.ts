import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeTurnResult } from "../runtime-api.js";
import { renderAgentCommand } from "./command-line.js";
import {
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import {
  CODEX_ACP_WRAPPER_COMMAND,
  makeEmptySessionStore,
  makeLeasedRuntime,
  makeLeaseStore,
  makeRuntime,
  makeTurn,
  observeLaunch,
  runtimeCommand,
  type TestSessionStore,
} from "./runtime.test-support.js";
import { ACPX_PROCESS_LEASE_MAX_ENTRIES } from "./state.js";

describe("AcpxRuntime diagnostic probes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { wrapperRoot: "/tmp/openclaw/acpx", command: CODEX_ACP_WRAPPER_COMMAND },
    {
      wrapperRoot: String.raw`C:\OpenClaw State\acpx`,
      command: [
        String.raw`C:\Program Files\node.exe`,
        String.raw`C:\OpenClaw State\acpx\codex-acp-wrapper.mjs`,
      ],
    },
  ])(
    "leases generated-wrapper probes at the pre-spawn boundary ($wrapperRoot)",
    async ({ wrapperRoot, command }) => {
      const events: string[] = [];
      const baseStore: TestSessionStore = makeEmptySessionStore();
      const leaseStore = makeLeaseStore();
      leaseStore.store.save.mockImplementation(async (lease: Record<string, unknown>) => {
        events.push("lease-saved");
        leaseStore.leases.set(String(lease.leaseId), lease);
      });
      const { runtime, probe } = makeRuntime(
        baseStore,
        {
          openclawGatewayInstanceId: "gateway-test",
          openclawProcessLeaseStore: leaseStore.store,
          openclawWrapperRoot: wrapperRoot,
          agentRegistry: {
            resolve: (agentName: string) => (agentName === "codex" ? command : agentName),
            list: () => ["codex"],
          },
        },
        {
          openclawProcessCleanup: {
            listProcesses: vi.fn(async () => {
              events.push("process-inspected");
              return [];
            }),
          },
        },
      );
      let launchedCommand = "";
      probe.mockImplementation(async () => {
        await observeLaunch(runtime);
        events.push("probe-entered");
        launchedCommand = renderAgentCommand(runtimeCommand(runtime));
        return { ok: true, message: "ready" };
      });

      await runtime.doctor();

      expect(events).toEqual(["lease-saved", "probe-entered", "process-inspected"]);
      expect(launchedCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
      expect(launchedCommand).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
      expect(Array.from(leaseStore.leases.values())).toEqual([
        expect.objectContaining({ rootPid: 0, state: "open" }),
      ]);
      expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
    },
  );

  it("settles each diagnostic probe cleanup before starting the next probe", async () => {
    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const events: string[] = [];
    const { runtime, probe } = makeRuntime(
      makeEmptySessionStore(),
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: makeLeaseStore().store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: () => CODEX_ACP_WRAPPER_COMMAND,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => {
            events.push("cleanup");
            return [];
          }),
        },
      },
    );
    probe.mockImplementationOnce(async () => {
      events.push("first-started");
      firstEntered.resolve();
      await releaseFirst.promise;
      return { ok: true, message: "ready" };
    });
    probe.mockImplementation(async () => {
      events.push("second-started");
      return { ok: true, message: "ready" };
    });
    const first = runtime.doctor();
    await firstEntered.promise;
    const second = runtime.doctor();
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-started", "cleanup", "second-started", "cleanup"]);
  });

  it("adopts current probe policy without replacing an admitted turn", async () => {
    let probeAgent = "claude";
    const completed = createDeferred<AcpRuntimeTurnResult>();
    const sessionKey = "agent:main:acp:policy";
    const { runtime, delegate, probe } = makeRuntime(
      {
        load: async () => ({ acpxRecordId: sessionKey, agentCommand: "claude" }),
        save: async () => {},
      },
      { getProbeAgent: () => probeAgent },
    );
    const shutdown = vi.spyOn(delegate, "shutdown");
    vi.spyOn(delegate, "startTurn").mockImplementation((input) =>
      makeTurn(input, { result: completed.promise }),
    );
    const turn = runtime.startTurn({
      handle: {
        sessionKey,
        backend: "acpx",
        runtimeSessionName: sessionKey,
        acpxRecordId: sessionKey,
      },
      text: "continue",
      mode: "prompt",
      requestId: "policy-turn",
    });
    await turn.promptStarted;
    try {
      probe.mockResolvedValueOnce({ ok: false, message: "unavailable" });
      await runtime.doctor();
      expect(runtime.isHealthy()).toBe(false);
      probeAgent = "gemini";
      expect(runtime.isHealthy()).toBe(true);
      await runtime.doctor();
      expect(probe.mock.calls.map(([options]) => options.probeAgent)).toEqual(["claude", "gemini"]);
      expect(runtime.isHealthy()).toBe(true);
      expect(shutdown).not.toHaveBeenCalled();
      completed.resolve({ status: "completed" });
      await expect(turn.result).resolves.toEqual({ status: "completed" });
    } finally {
      completed.resolve({ status: "completed" });
      await runtime.shutdown();
    }
  });

  it("reaps a fulfilled probe wrapper that exact live evidence still finds", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    let launchedCommand = "";
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const { runtime, probe } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => [
            { pid: 710, ppid: 1, command: launchedCommand },
            { pid: 711, ppid: 710, command: "node adapter-child.js" },
          ]),
          killProcess: vi.fn((pid, signal) => {
            killed.push({ pid, signal });
          }),
          sleep: vi.fn(async () => {}),
        },
      },
    );
    probe.mockImplementation(async () => {
      await observeLaunch(runtime);
      launchedCommand = renderAgentCommand(runtimeCommand(runtime));
      return { ok: true, message: "ready" };
    });

    await runtime.doctor();

    expect(killed.slice(0, 2)).toEqual([
      { pid: 711, signal: "SIGTERM" },
      { pid: 710, signal: "SIGTERM" },
    ]);
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
  });

  it("retains a fulfilled probe lease when live evidence is unavailable", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    const { runtime, probe } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => {
            throw new Error("process evidence unavailable");
          }),
        },
      },
    );
    probe.mockImplementation(async () => {
      await observeLaunch(runtime);
      return { ok: true, message: "ready" };
    });

    await runtime.doctor();

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({ rootPid: 0, state: "open" }),
    ]);
  });

  it("coalesces repeated probe uncertainty before it can evict a live lease", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    leaseStore.leases.set("lease-live", {
      leaseId: "lease-live",
      gatewayInstanceId: "gateway-test",
      sessionKey: "agent:codex:acp:live",
      wrapperRoot: "/tmp/openclaw/acpx",
      wrapperPath: "/tmp/openclaw/acpx/codex-acp-wrapper.mjs",
      rootPid: 700,
      commandHash: "hash-live",
      startedAt: 1,
      state: "open",
    });
    leaseStore.store.save.mockImplementation(async (lease: Record<string, unknown>) => {
      const leaseId = String(lease.leaseId);
      leaseStore.leases.delete(leaseId);
      leaseStore.leases.set(leaseId, lease);
      if (leaseStore.leases.size > ACPX_PROCESS_LEASE_MAX_ENTRIES) {
        const oldestLeaseId = leaseStore.leases.keys().next().value;
        if (oldestLeaseId) {
          leaseStore.leases.delete(oldestLeaseId);
        }
      }
    });
    const { runtime, probe } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? CODEX_ACP_WRAPPER_COMMAND : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => []),
        },
      },
    );
    const probeLeaseIds = new Set<string>();
    probe.mockImplementation(async () => {
      await observeLaunch(runtime);
      const command = runtimeCommand(runtime);
      const identity = readAcpxProcessLeaseIdentity(command);
      expect(identity).toBeDefined();
      probeLeaseIds.add(String(identity?.leaseId));
      return { ok: true, message: "ready" };
    });

    for (let index = 0; index <= ACPX_PROCESS_LEASE_MAX_ENTRIES; index += 1) {
      await runtime.doctor();
    }

    const { runtime: updatedRuntime, probe: updatedProbe } = makeRuntime(
      baseStore,
      {
        openclawGatewayInstanceId: "gateway-test",
        openclawProcessLeaseStore: leaseStore.store,
        openclawWrapperRoot: "/tmp/openclaw/acpx",
        agentRegistry: {
          resolve: (agentName: string) =>
            agentName === "codex" ? `${CODEX_ACP_WRAPPER_COMMAND} --updated` : agentName,
          list: () => ["codex"],
        },
      },
      {
        openclawProcessCleanup: {
          listProcesses: vi.fn(async () => []),
        },
      },
    );
    updatedProbe.mockImplementation(async () => {
      await observeLaunch(updatedRuntime);
      const command = runtimeCommand(updatedRuntime);
      const identity = readAcpxProcessLeaseIdentity(command);
      expect(identity).toBeDefined();
      probeLeaseIds.add(String(identity?.leaseId));
      return { ok: true, message: "ready" };
    });
    await updatedRuntime.doctor();

    expect(leaseStore.leases.has("lease-live")).toBe(true);
    expect(leaseStore.leases.size).toBe(2);
    expect(probeLeaseIds.size).toBe(1);
  });

  it("leases generated-wrapper doctor probes and keeps uncertain failures open", async () => {
    const baseStore: TestSessionStore = makeEmptySessionStore();
    const leaseStore = makeLeaseStore();
    const { runtime, probe } = makeLeasedRuntime(baseStore, leaseStore);
    probe.mockImplementation(async () => {
      await observeLaunch(runtime);
      const command = runtimeCommand(runtime);
      expect(command).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
      throw new Error("probe launch state unknown");
    });

    await expect(runtime.doctor()).rejects.toThrow("probe launch state unknown");

    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({
        gatewayInstanceId: "gateway-test",
        rootPid: 0,
        sessionKey: "openclaw:acpx:probe",
        state: "open",
      }),
    ]);
    expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
  });
});
