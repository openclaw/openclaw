import { describe, expect, it } from "vitest";
import type { SmolCommandRunner } from "./cli.js";
import { resolveSmolPluginConfig } from "./config.js";
import { buildSmolCreateArgv, buildSmolReadyArgv, ensureSmolMachine } from "./lifecycle.js";

const config = resolveSmolPluginConfig(undefined);
const machineName = "openclaw-smol-0123456789abcdef";

type EngineState = {
  exists: boolean;
  running: boolean;
  network: boolean;
  /** Readiness probes that still fail before the guest answers. */
  notReadyProbes?: number;
  failCreate?: boolean;
};

/** A scripted engine: lifecycle verbs mutate state, inventory verbs report it. */
function createEngine(initial: EngineState) {
  const state = { notReadyProbes: 0, ...initial };
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
              ? [{ name: machineName, state: state.running ? "running" : "stopped" }]
              : [],
          ),
        };
      case "status":
        return state.exists
          ? { ...ok, stdout: JSON.stringify({ running: state.running, network: state.network }) }
          : { code: 1, stdout: "", stderr: "machine not found" };
      case "create":
        if (state.failCreate) {
          return { code: 1, stdout: "", stderr: "machine already exists" };
        }
        Object.assign(state, { exists: true, running: false, network: argv.includes("--net") });
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
    mounts: [{ hostPath: "/tmp/ws", guestPath: "/workspace", readOnly: false }],
    readyDelayMs: 0,
  });
}

describe("buildSmolCreateArgv", () => {
  it("creates a networked machine with the sandbox mounts and a keep-alive workload", () => {
    expect(
      buildSmolCreateArgv({
        config,
        machineName,
        scopeKey: "agent:main:main",
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
      "--net",
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

  it("probes readiness with a guest true", () => {
    expect(buildSmolReadyArgv(config, machineName)).toEqual([
      "smol",
      "machine",
      "exec",
      "--name",
      machineName,
      "--local",
      "--",
      "true",
    ]);
  });
});

describe("ensureSmolMachine", () => {
  it("pulls with network, then restarts a no-egress machine without it", async () => {
    const engine = createEngine({ exists: false, running: false, network: false });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create --name .* --net /u),
      "ls --json --local",
      `start --name ${machineName} --local`,
      `stop --name ${machineName} --local`,
      `update --name ${machineName} --no-net`,
      `start --name ${machineName} --local --branchable`,
      `exec --name ${machineName} --local -- true`,
    ]);
    expect(engine.state).toMatchObject({ exists: true, running: true, network: false });
  });

  it("boots a networked machine once", async () => {
    const engine = createEngine({ exists: false, running: false, network: false });
    await ensure(engine, true);
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create /u),
      "ls --json --local",
      `start --name ${machineName} --local --branchable`,
      `exec --name ${machineName} --local -- true`,
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
      mounts: [],
      readyDelayMs: 0,
    });
    expect(engine.calls).toContain(`start --name ${machineName} --local`);
  });

  it("adopts a running machine whose network already matches", async () => {
    const engine = createEngine({ exists: true, running: true, network: false });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      `status --name ${machineName} --local --json`,
      `exec --name ${machineName} --local -- true`,
    ]);
  });

  it("repairs a machine left networked by a crash before the switch", async () => {
    const engine = createEngine({ exists: true, running: true, network: true });
    await ensure(engine, false);
    expect(engine.calls).toEqual([
      "ls --json --local",
      `status --name ${machineName} --local --json`,
      `stop --name ${machineName} --local`,
      `update --name ${machineName} --no-net`,
      `start --name ${machineName} --local --branchable`,
      `exec --name ${machineName} --local -- true`,
    ]);
    expect(engine.state).toMatchObject({ running: true, network: false });
  });

  it("turns network on for a stopped machine after the sandbox network changed", async () => {
    const engine = createEngine({ exists: true, running: false, network: false });
    await ensure(engine, true);
    expect(engine.calls).toEqual([
      "ls --json --local",
      `status --name ${machineName} --local --json`,
      `update --name ${machineName} --net`,
      `start --name ${machineName} --local --branchable`,
      `exec --name ${machineName} --local -- true`,
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
      mounts: [],
      readyDelayMs: 0,
    });
    expect(engine.calls).toEqual([
      "ls --json --local",
      expect.stringMatching(/^create /u),
      "ls --json --local",
      `exec --name ${machineName} --local -- true`,
    ]);
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
