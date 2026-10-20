import { describe, expect, it } from "vitest";
import type { SmolCommandRunner } from "./cli.js";
import { resolveSmolPluginConfig } from "./config.js";
import {
  buildSmolCreateArgv,
  ensureSmolMachine,
  hashSmolMountPlan,
  SMOL_MOUNT_PLAN_LABEL,
  SMOL_NETWORK_POLICY_LABEL,
  smolMachineMountsMatch,
  smolMachineNetworkPolicyMatches,
  type SmolMount,
} from "./lifecycle.js";

const config = resolveSmolPluginConfig(undefined);
const machineName = "openclaw-smol-0123456789abcdef";
const mounts: SmolMount[] = [{ hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: false }];

type EngineState = {
  exists: boolean;
  running: boolean;
  network: boolean;
  /** Readiness probes that still fail before the guest answers. */
  notReadyProbes?: number;
  failCreate?: boolean;
  /** Mount plan label the existing machine carries; defaults to the requested mounts. */
  mountPlan?: string;
  /** Egress policy label the existing machine carries; defaults to match `network`. */
  networkPolicy?: string;
};

/** A scripted engine: lifecycle verbs mutate state, inventory verbs report it. */
function createEngine(initial: EngineState) {
  const state = {
    notReadyProbes: 0,
    mountPlan: hashSmolMountPlan(mounts),
    networkPolicy: initial.network ? "egress" : "none",
    ...initial,
  };
  const calls: string[] = [];
  const run: SmolCommandRunner = async (argv) => {
    const verb = argv[2] ?? "";
    calls.push(argv.slice(2).join(" "));
    const ok = { code: 0, stdout: "", stderr: "" };
    switch (verb) {
      case "ls":
        return {
          ...ok,
          stdout: JSON.stringify(
            state.exists
              ? [
                  {
                    name: machineName,
                    state: state.running ? "running" : "stopped",
                    labels: {
                      [SMOL_MOUNT_PLAN_LABEL]: state.mountPlan,
                      [SMOL_NETWORK_POLICY_LABEL]: state.networkPolicy,
                    },
                  },
                ]
              : [],
          ),
        };
      case "rm":
        if (state.running) {
          return { code: 1, stdout: "", stderr: "machine is running" };
        }
        Object.assign(state, { exists: false, network: false });
        return ok;
      case "status":
        return state.exists
          ? { ...ok, stdout: JSON.stringify({ running: state.running, network: state.network }) }
          : { code: 1, stdout: "", stderr: "machine not found" };
      case "create":
        if (state.failCreate) {
          return { code: 1, stdout: "", stderr: "machine already exists" };
        }
        Object.assign(state, {
          exists: true,
          running: false,
          network: argv.includes("--net"),
        });
        for (const arg of argv) {
          if (arg.startsWith(`${SMOL_MOUNT_PLAN_LABEL}=`)) {
            state.mountPlan = arg.slice(SMOL_MOUNT_PLAN_LABEL.length + 1);
          }
          if (arg.startsWith(`${SMOL_NETWORK_POLICY_LABEL}=`)) {
            state.networkPolicy = arg.slice(SMOL_NETWORK_POLICY_LABEL.length + 1);
          }
        }
        return ok;
      case "start":
        state.running = true;
        return ok;
      case "stop":
        state.running = false;
        return ok;
      case "update":
        if (state.running) {
          return { code: 1, stdout: "", stderr: "machine must be stopped" };
        }
        state.network = argv.includes("--net");
        return ok;
      case "exec":
        if (!state.running) {
          return { code: 1, stdout: "", stderr: "machine is not running" };
        }
        if (state.notReadyProbes > 0) {
          state.notReadyProbes -= 1;
          return { code: 1, stdout: "", stderr: "agent not ready" };
        }
        return ok;
      default:
        return { code: 1, stdout: "", stderr: `unexpected verb ${verb}` };
    }
  };
  return { state, calls, run };
}

function ensure(engine: ReturnType<typeof createEngine>, network: boolean) {
  return ensureSmolMachine({
    context: { config, run: engine.run },
    machineName,
    scopeKey: "agent:main:main",
    network,
    mounts,
    readyDelayMs: 0,
  });
}

describe("buildSmolCreateArgv", () => {
  it("creates a no-egress machine without network, with the sandbox mounts and a keep-alive workload", () => {
    expect(
      buildSmolCreateArgv({
        config,
        machineName,
        scopeKey: "agent:main:main",
        network: false,
        mounts: [
          { hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: false },
          { hostPath: "/tmp/skills", guestPath: "/workspace/skills", readOnly: true },
        ],
      }),
    ).toEqual([
      "smol",
      "machine",
      "create",
      "--name",
      machineName,
      "--image",
      "python:3.12-slim",
      "--cpus",
      "2",
      "--mem",
      "2048",
      "--label",
      "openclaw.sandbox=1",
      "--label",
      "openclaw.scopeKey=agent:main:main",
      "--label",
      `${SMOL_MOUNT_PLAN_LABEL}=${hashSmolMountPlan([
        { hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: false },
        { hostPath: "/tmp/skills", guestPath: "/workspace/skills", readOnly: true },
      ])}`,
      "--label",
      `${SMOL_NETWORK_POLICY_LABEL}=none`,
      "--volume",
      "/tmp/ws:/workspace:rw",
      "--volume",
      "/tmp/skills:/workspace/skills:ro",
      "--",
      "tail",
      "-f",
      "/dev/null",
    ]);
  });

});

describe("ensureSmolMachine", () => {
  const status = `status --name ${machineName} --local --json`;
  const start = `start --name ${machineName} --local --branchable`;
  const ready = `exec --name ${machineName} --local -- true`;

  it("creates a no-egress machine without network and boots it once", async () => {
    const engine = createEngine({ exists: false, running: false, network: false });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create .* --label openclaw\.network=none --volume /u),
      "ls --json --local",
      status,
      start,
      ready,
    ]);
    // The guest never runs with network, not even to fetch its image.
    expect(engine.calls.some((call) => / --net( |$)/u.test(call))).toBe(false);
    expect(engine.state).toMatchObject({ exists: true, running: true, network: false });
  });

  it("boots a networked machine once", async () => {
    const engine = createEngine({ exists: false, running: false, network: false });
    await ensure(engine, true);
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create .* --label openclaw\.network=egress --net /u),
      "ls --json --local",
      status,
      start,
      ready,
    ]);
    expect(engine.state).toMatchObject({ running: true, network: true });
  });

  it("honors branchable: false", async () => {
    const engine = createEngine({ exists: true, running: false, network: true });
    await ensureSmolMachine({
      context: { config: resolveSmolPluginConfig({ branchable: false }), run: engine.run },
      machineName,
      scopeKey: "s",
      network: true,
      mounts,
      readyDelayMs: 0,
    });
    expect(engine.calls).toContain(`start --name ${machineName} --local`);
  });

  it("adopts a running machine whose network already matches", async () => {
    const engine = createEngine({ exists: true, running: true, network: false });
    await ensure(engine, false);
    expect(engine.calls).toEqual(["ls --json --local", status, ready]);
  });

  it("starts a stopped no-egress machine left by a crash after create", async () => {
    const engine = createEngine({
      exists: true,
      running: false,
      network: false,
      notReadyProbes: 2,
    });
    await ensure(engine, false);
    expect(engine.calls).toEqual(["ls --json --local", status, start, ready, ready, ready]);
    expect(engine.state).toMatchObject({ running: true, network: false });
  });

  it("replaces a no-egress machine whose network was turned on outside the plugin", async () => {
    const engine = createEngine({
      exists: true,
      running: true,
      network: true,
      networkPolicy: "none",
    });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      status,
      `stop --name ${machineName} --local`,
      `rm --name ${machineName} --yes --local`,
      expect.stringMatching(/^create .* --label openclaw\.network=none --volume /u),
      "ls --json --local",
      status,
      start,
      ready,
    ]);
    expect(engine.state).toMatchObject({ running: true, network: false });
  });

  it("replaces a guest that ran with egress instead of booting it under none", async () => {
    // Created for egress, so earlier tool commands may have rewritten anything
    // in the guest overlay, including the readiness probe's `true`. Under the
    // reduced policy it must never run again.
    const engine = createEngine({
      exists: true,
      running: true,
      network: true,
      networkPolicy: "egress",
    });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      status,
      `stop --name ${machineName} --local`,
      `rm --name ${machineName} --yes --local`,
      expect.stringMatching(/^create .* --label openclaw\.network=none --volume /u),
      "ls --json --local",
      status,
      start,
      ready,
    ]);
    expect(engine.state).toMatchObject({ running: true, network: false, networkPolicy: "none" });
  });

  it("replaces a no-egress machine when the sandbox gains egress", async () => {
    const engine = createEngine({ exists: true, running: true, network: false });
    await ensure(engine, true);
    expect(engine.calls.slice(0, 5)).toEqual([
      "ls --json --local",
      status,
      `stop --name ${machineName} --local`,
      `rm --name ${machineName} --yes --local`,
      expect.stringMatching(/^create .* --label openclaw\.network=egress --net /u),
    ]);
    expect(engine.state).toMatchObject({ running: true, network: true, networkPolicy: "egress" });
  });

  it("replaces a machine created before network policies were recorded", async () => {
    const engine = createEngine({
      exists: true,
      running: true,
      network: true,
      networkPolicy: "",
    });
    await ensure(engine, false);
    expect(engine.calls.slice(0, 4)).toEqual([
      "ls --json --local",
      status,
      `stop --name ${machineName} --local`,
      `rm --name ${machineName} --yes --local`,
    ]);
    expect(engine.calls.indexOf(ready)).toBeGreaterThan(
      engine.calls.findIndex((call) => call.startsWith("create ")),
    );
  });

  it("replaces a machine whose mounts no longer match the sandbox policy", async () => {
    // Created under workspaceAccess "rw"; the sandbox now asks for "ro".
    const engine = createEngine({
      exists: true,
      running: true,
      network: true,
      mountPlan: hashSmolMountPlan([
        { hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: false },
      ]),
    });
    await ensureSmolMachine({
      context: { config, run: engine.run },
      machineName,
      scopeKey: "agent:main:main",
      network: true,
      mounts: [{ hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: true }],
      readyDelayMs: 0,
    });
    expect(engine.calls).toEqual([
      "ls --json --local",
      status,
      `stop --name ${machineName} --local`,
      `rm --name ${machineName} --yes --local`,
      expect.stringMatching(/^create .* --volume \/tmp\/ws:\/workspace:ro /u),
      "ls --json --local",
      status,
      start,
      ready,
    ]);
    expect(engine.state.mountPlan).toBe(
      hashSmolMountPlan([{ hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: true }]),
    );
  });

  it("replaces a machine created before mount plans were recorded", async () => {
    const engine = createEngine({ exists: true, running: false, network: true, mountPlan: "" });
    await ensure(engine, true);
    expect(engine.calls.slice(0, 4)).toEqual([
      "ls --json --local",
      status,
      `rm --name ${machineName} --yes --local`,
      expect.stringMatching(/^create /u),
    ]);
  });

  it("drives the engine CLI without --local and removes with --force", async () => {
    const engine = createEngine({ exists: true, running: false, network: true, mountPlan: "" });
    await ensureSmolMachine({
      context: { config: resolveSmolPluginConfig({ command: "/opt/bin/smolvm" }), run: engine.run },
      machineName,
      scopeKey: "s",
      network: true,
      mounts,
      readyDelayMs: 0,
    });
    expect(engine.calls).toEqual([
      "ls --json",
      `status --name ${machineName} --json`,
      `rm --name ${machineName} --force`,
      expect.stringMatching(/^create /u),
      "ls --json",
      `status --name ${machineName} --json`,
      `start --name ${machineName} --branchable`,
      `exec --name ${machineName} -- true`,
    ]);
    expect(engine.calls.some((call) => call.includes("--local"))).toBe(false);
  });

  it("restores egress an operator removed from a machine created for egress", async () => {
    const engine = createEngine({
      exists: true,
      running: false,
      network: false,
      networkPolicy: "egress",
    });
    await ensure(engine, true);
    expect(engine.calls).toEqual([
      "ls --json --local",
      status,
      `update --name ${machineName} --net`,
      start,
      ready,
    ]);
  });

  it("retries the readiness probe while the guest is still booting", async () => {
    const engine = createEngine({ exists: true, running: true, network: true, notReadyProbes: 3 });
    await ensure(engine, true);
    expect(engine.calls.filter((call) => call.startsWith("exec "))).toHaveLength(4);
  });

  it("adopts the machine when a concurrent session won the create race", async () => {
    const engine = createEngine({ exists: false, running: false, network: true, failCreate: true });
    const run: SmolCommandRunner = async (argv, options) => {
      if (argv[2] === "create") {
        // The other session's create landed first.
        Object.assign(engine.state, { exists: true, running: true });
      }
      return await engine.run(argv, options);
    };
    await ensureSmolMachine({
      context: { config, run },
      machineName,
      scopeKey: "s",
      network: true,
      mounts,
      readyDelayMs: 0,
    });
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create /u),
      "ls --json --local",
      status,
      ready,
    ]);
  });

  it("refuses a machine a concurrent session created for a different policy", async () => {
    const engine = createEngine({ exists: false, running: false, network: true, failCreate: true });
    const run: SmolCommandRunner = async (argv, options) => {
      if (argv[2] === "create") {
        // The other session created it for egress; this one wants none.
        Object.assign(engine.state, { exists: true, running: true, networkPolicy: "egress" });
      }
      return await engine.run(argv, options);
    };
    await expect(
      ensureSmolMachine({
        context: { config, run },
        machineName,
        scopeKey: "s",
        network: false,
        mounts,
        readyDelayMs: 0,
      }),
    ).rejects.toThrow("was created concurrently for a different sandbox policy");
    expect(engine.calls.some((call) => call.startsWith("exec "))).toBe(false);
  });

  it("surfaces a failed create when no machine appeared", async () => {
    const engine = createEngine({ exists: false, running: false, network: true, failCreate: true });
    await expect(ensure(engine, true)).rejects.toThrow(
      "smol machine create failed: machine already exists",
    );
  });

  it("surfaces a machine that never becomes ready", async () => {
    const engine = createEngine({ exists: true, running: true, network: true, notReadyProbes: 99 });
    await expect(ensure(engine, true)).rejects.toThrow(
      `smol machine ${machineName} did not accept commands after start: smol machine exec failed: agent not ready`,
    );
  });

  it("rechecks runtime authority before each engine side effect", async () => {
    const engine = createEngine({ exists: false, running: false, network: true });
    let retired = false;
    const assertCurrent = () => {
      if (retired) {
        throw new Error("runtime retired");
      }
    };
    const run: SmolCommandRunner = async (argv, options) => {
      if (argv[2] === "create") {
        retired = true;
      }
      return await engine.run(argv, options);
    };
    await expect(
      ensureSmolMachine({
        context: { config, run },
        machineName,
        scopeKey: "s",
        network: true,
        mounts: [],
        assertCurrent,
        readyDelayMs: 0,
      }),
    ).rejects.toThrow("runtime retired");
    expect(engine.calls.some((call) => call.startsWith("start "))).toBe(false);
  });
});

describe("network policy labels", () => {
  it("matches a machine only when it was created for the requested egress policy", () => {
    const none = { labels: { [SMOL_NETWORK_POLICY_LABEL]: "none" } };
    const egress = { labels: { [SMOL_NETWORK_POLICY_LABEL]: "egress" } };
    expect(smolMachineNetworkPolicyMatches(none, false)).toBe(true);
    expect(smolMachineNetworkPolicyMatches(none, true)).toBe(false);
    expect(smolMachineNetworkPolicyMatches(egress, true)).toBe(true);
    expect(smolMachineNetworkPolicyMatches(egress, false)).toBe(false);
    expect(smolMachineNetworkPolicyMatches({ labels: {} }, false)).toBe(false);
  });
});

describe("mount plans", () => {
  it("hashes mounts independent of order and sensitive to access", () => {
    const rw: SmolMount = { hostPath: "/a", guestPath: "/w", readOnly: false };
    const ro: SmolMount = { ...rw, readOnly: true };
    const skills: SmolMount = { hostPath: "/s", guestPath: "/w/skills", readOnly: true };
    expect(hashSmolMountPlan([rw, skills])).toBe(hashSmolMountPlan([skills, rw]));
    expect(hashSmolMountPlan([rw])).not.toBe(hashSmolMountPlan([ro]));
    expect(hashSmolMountPlan([rw])).not.toBe(hashSmolMountPlan([rw, skills]));
    expect(hashSmolMountPlan([])).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("matches a machine only when its recorded plan equals the requested mounts", () => {
    const mount: SmolMount = { hostPath: "/a", guestPath: "/w", readOnly: false };
    const plan = [mount];
    expect(
      smolMachineMountsMatch(
        { labels: { [SMOL_MOUNT_PLAN_LABEL]: hashSmolMountPlan(plan) } },
        plan,
      ),
    ).toBe(true);
    expect(smolMachineMountsMatch({ labels: {} }, plan)).toBe(false);
    expect(
      smolMachineMountsMatch({ labels: { [SMOL_MOUNT_PLAN_LABEL]: hashSmolMountPlan(plan) } }, [
        { ...mount, readOnly: true },
      ]),
    ).toBe(false);
  });
});
