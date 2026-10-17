import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import type { AcpRuntimeTurnResult } from "../runtime-api.js";
import { renderAgentCommand, type AcpxAgentCommand } from "./command-line.js";
import {
  OPENCLAW_ACPX_LEASE_ID_ARG,
  OPENCLAW_GATEWAY_INSTANCE_ID_ARG,
  readAcpxProcessLeaseIdentity,
} from "./process-lease.js";
import type { AcpxProcessSystemFixture } from "./process-reaper.test-support.js";
import { createTestGate } from "./runtime-process.test-support.js";
import {
  CODEX_ACP_WRAPPER_COMMAND,
  makeEmptySessionStore,
  makeLeaseStore,
  makeLeasedRuntime,
  makeRuntime,
  makeTurn,
  observeLaunch,
  runtimeCommand,
} from "./runtime.test-support.js";
import { ACPX_PROCESS_LEASE_MAX_ENTRIES } from "./state.js";

function makeProbeRuntime(
  leases: ReturnType<typeof makeLeaseStore>,
  cleanup?: AcpxProcessSystemFixture,
  command?: AcpxAgentCommand,
  wrapperRoot?: string,
) {
  return makeLeasedRuntime(makeEmptySessionStore(), leases, cleanup, command, wrapperRoot);
}

function observeProbe(
  fixture: ReturnType<typeof makeProbeRuntime>,
  onLaunch: (command: AcpxAgentCommand) => void,
) {
  fixture.probe.mockImplementation(async () => {
    await observeLaunch(fixture.runtime);
    onLaunch(runtimeCommand(fixture.runtime));
    return { ok: true, message: "ready" };
  });
}

it.each(["portable", "live-root", "uncertain"])(
  "leases before spawn and preserves cleanup evidence (%s)",
  async (scenario) => {
    const liveRoot = scenario === "live-root";
    const events: string[] = [];
    const leaseStore = makeLeaseStore();
    leaseStore.store.save.mockImplementation(async (lease: Record<string, unknown>) => {
      events.push("lease-saved");
      leaseStore.leases.set(String(lease.leaseId), lease);
    });
    let launchedCommand = "";
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fixture = makeProbeRuntime(
      leaseStore,
      {
        listProcesses: async () => {
          events.push("process-inspected");
          return liveRoot
            ? [
                { pid: 710, ppid: 1, command: launchedCommand },
                { pid: 711, ppid: 710, command: "node adapter-child.js" },
              ]
            : [];
        },
        killProcess: (pid, signal) => {
          killed.push({ pid, signal });
        },
        sleep: async () => {},
      },
      scenario === "portable"
        ? [
            String.raw`C:\Program Files\node.exe`,
            String.raw`C:\OpenClaw State\acpx\codex-acp-wrapper.mjs`,
          ]
        : CODEX_ACP_WRAPPER_COMMAND,
      scenario === "portable" ? String.raw`C:\OpenClaw State\acpx` : "/tmp/openclaw/acpx",
    );
    observeProbe(fixture, (command) => {
      events.push("probe-entered");
      launchedCommand = renderAgentCommand(command);
      if (scenario === "uncertain") {
        throw new Error("probe launch state unknown");
      }
    });

    if (scenario === "uncertain") {
      await expect(fixture.runtime.doctor()).rejects.toThrow("probe launch state unknown");
    } else {
      await fixture.runtime.doctor();
    }

    if (liveRoot) {
      expect(killed.slice(0, 2)).toEqual([
        { pid: 711, signal: "SIGTERM" },
        { pid: 710, signal: "SIGTERM" },
      ]);
    } else if (scenario === "portable") {
      expect(events).toEqual(["lease-saved", "probe-entered", "process-inspected"]);
    }
    if (!liveRoot) {
      expect(leaseStore.store.markState).not.toHaveBeenCalledWith(expect.any(String), "lost");
    }
    expect(launchedCommand).toContain(OPENCLAW_ACPX_LEASE_ID_ARG);
    expect(launchedCommand).toContain(`${OPENCLAW_GATEWAY_INSTANCE_ID_ARG} gateway-test`);
    expect(Array.from(leaseStore.leases.values())).toEqual([
      expect.objectContaining({
        rootPid: 0,
        state: "open",
        gatewayInstanceId: "gateway-test",
        sessionKey: "openclaw:acpx:probe",
      }),
    ]);
  },
);

it("settles each diagnostic probe cleanup before starting the next probe", async () => {
  const firstProbe = createTestGate();
  const events: string[] = [];
  const { runtime, probe } = makeProbeRuntime(makeLeaseStore(), {
    listProcesses: vi.fn(async () => {
      events.push("cleanup");
      return [];
    }),
  });
  probe.mockImplementationOnce(async () => {
    events.push("first-started");
    await firstProbe.hold();
    return { ok: true, message: "ready" };
  });
  probe.mockImplementation(async () => {
    events.push("second-started");
    return { ok: true, message: "ready" };
  });
  const first = runtime.doctor();
  await firstProbe.entered;
  const second = runtime.doctor();
  firstProbe.release();
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

it("coalesces repeated probe uncertainty before it can evict a live lease", async () => {
  const leaseStore = makeLeaseStore();
  // Probes never read the sibling row; its key tests bounded-store eviction.
  leaseStore.leases.set("lease-live", {});
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
  const probeLeaseIds = new Set<string>();
  const recordLease = (command: AcpxAgentCommand) => {
    const identity = readAcpxProcessLeaseIdentity(command);
    expect(identity).toBeDefined();
    probeLeaseIds.add(String(identity?.leaseId));
  };
  const fixture = makeProbeRuntime(leaseStore, { listProcesses: async () => [] });
  observeProbe(fixture, recordLease);

  for (let index = 0; index <= ACPX_PROCESS_LEASE_MAX_ENTRIES; index += 1) {
    await fixture.runtime.doctor();
  }

  const updated = makeProbeRuntime(
    leaseStore,
    { listProcesses: async () => [] },
    `${CODEX_ACP_WRAPPER_COMMAND} --updated`,
  );
  observeProbe(updated, recordLease);
  await updated.runtime.doctor();

  expect(leaseStore.leases.has("lease-live")).toBe(true);
  expect(leaseStore.leases.size).toBe(2);
  expect(probeLeaseIds.size).toBe(1);
});
