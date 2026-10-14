import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildSmolMachineArgv,
  describeSmolMachine,
  describeSmolMachineStatus,
  formatSmolCliFailure,
  runSmolCli,
  smolRemoveFlags,
  smolLocalFlag,
  type SmolCliContext,
  type SmolMachineSummary,
} from "./cli.js";
import type { ResolvedSmolPluginConfig } from "./config.js";

export type SmolMount = { hostPath: string; guestPath: string; readOnly: boolean };

export type EnsureSmolMachineParams = {
  context: SmolCliContext;
  machineName: string;
  scopeKey: string;
  /** Egress the sandbox may use once tools run. */
  network: boolean;
  mounts: readonly SmolMount[];
  /** Synchronously recheck runtime authority before each engine side effect. */
  assertCurrent?: () => void;
  /** Test seam; production waits between readiness probes. */
  readyDelayMs?: number;
};

/**
 * Label recording the mounts a machine was created with. Mounts are fixed at
 * create time and are the filesystem authority boundary, so a machine whose
 * label disagrees with the mounts the sandbox config asks for now is replaced
 * before any guest command runs.
 */
export const SMOL_MOUNT_PLAN_LABEL = "openclaw.mountPlan";

export function hashSmolMountPlan(mounts: readonly SmolMount[]): string {
  const plan = [...mounts]
    .map(
      (mount) => `${mount.hostPath}\u0000${mount.guestPath}\u0000${mount.readOnly ? "ro" : "rw"}`,
    )
    .toSorted()
    .join("\n");
  return createHash("sha256").update(plan).digest("hex").slice(0, 16);
}

/** True when the machine was created with exactly the requested mounts. */
export function smolMachineMountsMatch(
  machine: Pick<SmolMachineSummary, "labels">,
  mounts: readonly SmolMount[],
): boolean {
  return machine.labels[SMOL_MOUNT_PLAN_LABEL] === hashSmolMountPlan(mounts);
}

/** The first start pulls the image; never let the lifecycle timeout cut a pull short. */
const SMOL_BOOT_TIMEOUT_FLOOR_MS = 300_000;
/** `machine start` returns when the VM boots; the guest init may still be settling. */
const SMOL_READY_ATTEMPTS = 20;
const SMOL_READY_DELAY_MS = 250;

/**
 * `smol machine create` argv for a sandbox machine. Network is always on at
 * creation: the guest pulls its own image on first start, and a machine
 * without egress cannot reach the registry. The no-egress case is enforced by
 * the lifecycle before any tool command runs.
 */
export function buildSmolCreateArgv(params: {
  config: ResolvedSmolPluginConfig;
  machineName: string;
  scopeKey: string;
  mounts: readonly SmolMount[];
}): string[] {
  const { config } = params;
  const argv = buildSmolMachineArgv(config, "create", params.machineName, [
    "--image",
    config.image,
    "--cpus",
    String(config.cpus),
    "--mem",
    String(config.memoryMb),
    "--label",
    "openclaw.sandbox=1",
    "--label",
    `openclaw.scopeKey=${params.scopeKey}`,
    "--label",
    `${SMOL_MOUNT_PLAN_LABEL}=${hashSmolMountPlan(params.mounts)}`,
    "--net",
  ]);
  for (const mount of params.mounts) {
    argv.push("--volume", `${mount.hostPath}:${mount.guestPath}:${mount.readOnly ? "ro" : "rw"}`);
  }
  // The workload only keeps the guest alive; every tool call is an exec. `tail`
  // works on GNU and BusyBox images where `sleep infinity` does not.
  argv.push("--", "tail", "-f", "/dev/null");
  return argv;
}

/** Readiness probe argv: a guest `true` through the local machine. */
export function buildSmolReadyArgv(
  config: ResolvedSmolPluginConfig,
  machineName: string,
): string[] {
  return buildSmolMachineArgv(config, "exec", machineName, [
    ...smolLocalFlag(config),
    "--",
    "true",
  ]);
}

/**
 * Bring the scope's machine to "running with the configured network" and wait
 * until it accepts commands. Every step is idempotent at its point of effect,
 * so a Gateway crash anywhere in the sequence is repaired by the next call.
 */
export async function ensureSmolMachine(params: EnsureSmolMachineParams): Promise<void> {
  const { context, machineName } = params;
  const { config } = context;
  const bootTimeoutMs = Math.max(config.timeoutMs, SMOL_BOOT_TIMEOUT_FLOOR_MS);
  const lifecycle = async (verb: string, args: string[], timeoutMs = config.timeoutMs) => {
    params.assertCurrent?.();
    const result = await runSmolCli(
      context,
      buildSmolMachineArgv(config, verb, machineName, args),
      timeoutMs,
    );
    if (result.code !== 0) {
      throw new Error(formatSmolCliFailure(`machine ${verb}`, result));
    }
  };

  const local = smolLocalFlag(config);
  const startArgs = [...local, ...(config.branchable ? ["--branchable"] : [])];

  params.assertCurrent?.();
  let machine = await describeSmolMachine(context, machineName);
  if (machine && !smolMachineMountsMatch(machine, params.mounts)) {
    // The mounts a machine carries are fixed at create time. A sandbox whose
    // workspace access was reduced (rw -> ro or none) must not keep executing
    // against the old writable mount, so the machine is replaced. The
    // workspace itself lives on the host; only guest-local state is rebuilt.
    if (machine.state === "running") {
      await lifecycle("stop", local);
    }
    await lifecycle("rm", smolRemoveFlags(config));
    machine = undefined;
  }
  let running: boolean;
  if (!machine) {
    params.assertCurrent?.();
    const created = await runSmolCli(
      context,
      buildSmolCreateArgv({
        config,
        machineName,
        scopeKey: params.scopeKey,
        mounts: params.mounts,
      }),
      bootTimeoutMs,
    );
    // Two sessions in one scope can race to create the same machine; the
    // loser adopts the winner's machine instead of failing the turn.
    machine = await describeSmolMachine(context, machineName);
    if (!machine) {
      throw new Error(formatSmolCliFailure("machine create", created));
    }
    running = machine.state === "running";
    if (!params.network) {
      await provisionThenDisableNetwork({ params, lifecycle, running, startArgs, bootTimeoutMs });
      running = false;
    }
  } else {
    // Adoption: a crash between the pull boot and the network switch, or an
    // operator config change, can leave the machine with the wrong network.
    const status = await describeSmolMachineStatus(context, machineName);
    running = status.running;
    if (status.network !== params.network) {
      if (params.network) {
        if (running) {
          await lifecycle("stop", local);
        }
        await lifecycle("update", ["--net"]);
      } else {
        // The machine may never have finished its first boot (a crash during
        // the image pull leaves it stopped and networked). Prove the guest
        // boots the image before taking its network away.
        await provisionThenDisableNetwork({ params, lifecycle, running, startArgs, bootTimeoutMs });
      }
      running = false;
    }
  }
  if (!running) {
    await lifecycle("start", startArgs, bootTimeoutMs);
  }
  await waitUntilReady(params);
}

/**
 * Pull boot for a machine that must end up without egress: start it with
 * network on (only the keep-alive workload runs), wait until the guest answers
 * a command, which proves the image is provisioned, then stop and switch the
 * network off. No tool command can reach the machine during this window.
 */
async function provisionThenDisableNetwork(input: {
  params: EnsureSmolMachineParams;
  lifecycle: (verb: string, args: string[], timeoutMs?: number) => Promise<void>;
  running: boolean;
  startArgs: string[];
  bootTimeoutMs: number;
}): Promise<void> {
  const local = smolLocalFlag(input.params.context.config);
  if (!input.running) {
    await input.lifecycle("start", input.startArgs, input.bootTimeoutMs);
  }
  await waitUntilReady(input.params);
  await input.lifecycle("stop", local);
  await input.lifecycle("update", ["--no-net"]);
}

async function waitUntilReady(params: EnsureSmolMachineParams): Promise<void> {
  const readyArgv = buildSmolReadyArgv(params.context.config, params.machineName);
  let last: string | undefined;
  for (let attempt = 0; attempt < SMOL_READY_ATTEMPTS; attempt += 1) {
    params.assertCurrent?.();
    const result = await runSmolCli(params.context, readyArgv);
    if (result.code === 0) {
      return;
    }
    last = formatSmolCliFailure("machine exec", result);
    await delay(params.readyDelayMs ?? SMOL_READY_DELAY_MS);
  }
  throw new Error(
    `smol machine ${params.machineName} did not accept commands after start: ${last ?? "no attempts"}`,
  );
}
