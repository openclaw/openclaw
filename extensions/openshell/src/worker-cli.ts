import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  mutateConfigFile,
  readConfigFileSnapshotForWrite,
} from "openclaw/plugin-sdk/config-mutation";
import { runUtf8CommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { z } from "zod";
import { buildOpenShellBaseArgv } from "./cli.js";
import { resolveOpenShellPluginConfig } from "./config.js";
import { createOpenShellWorkerNodeConfig, OPEN_SHELL_WORKER_BOOTSTRAP } from "./worker-launch.js";

type WorkerOptions = {
  targetFile?: string;
  profile?: string;
  device?: string;
  required?: boolean;
  apply?: boolean;
};

function requireWorker(config: OpenClawConfig) {
  const plugin = resolveOpenShellPluginConfig(config.plugins?.entries?.openshell?.config);
  if (!plugin.worker || plugin.providers.length === 0) {
    throw new Error(
      "Configure openshell.worker and at least one existing openshell.providers credential provider first. Worker setup never auto-creates providers or reads host model credentials.",
    );
  }
  return { plugin, worker: plugin.worker };
}

function requireName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 19) {
    throw new Error(
      "OpenShell worker sandbox names must be 1–19 lowercase letters, digits, or single hyphens.",
    );
  }
  return value;
}

async function readPairingTarget(file: string | undefined): Promise<string | undefined> {
  if (!file) {
    return undefined;
  }
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) {
      throw new Error("Pairing target must be a regular file of at most 64 KiB.");
    }
    const target = (await handle.readFile("utf8")).trim();
    if (!target || Buffer.byteLength(target) > 65536) {
      throw new Error(
        "Pairing target file must contain a nonempty join URL or setup code of at most 64 KiB.",
      );
    }
    return target;
  } finally {
    await handle.close();
  }
}

async function runOpenShellWorker(config: OpenClawConfig, sandbox: string, options: WorkerOptions) {
  const { plugin, worker } = requireWorker(config);
  requireName(sandbox);
  const target = await readPairingTarget(options.targetFile);
  const argv = buildOpenShellBaseArgv(plugin);
  // OpenShell owns attachment epochs, readiness, and the bounded wait. A failure
  // stops before creating the node process; no alternate inference route exists.
  for (const provider of plugin.providers) {
    const attached = await runUtf8CommandWithTimeout(
      [...argv, "sandbox", "provider", "attach", sandbox, provider, "--wait"],
      { timeoutMs: plugin.timeoutMs, killProcessTree: true },
    );
    if (attached.code !== 0) {
      throw new Error(
        "OpenShell credential attachment is not ready; inspect sandbox provider status before retrying. No node was started.",
      );
    }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const failures: unknown[] = [];
  try {
    const result = await runUtf8CommandWithTimeout(
      [
        ...argv,
        "sandbox",
        "exec",
        sandbox,
        "--no-tty",
        "--no-login-shell",
        "--",
        worker.nodeExecutable,
        "-e",
        OPEN_SHELL_WORKER_BOOTSTRAP,
      ],
      {
        input: JSON.stringify({ worker, config: createOpenShellWorkerNodeConfig(worker), target }),
        signal: controller.signal,
        killProcessTree: true,
        outputCapture: "discard",
        onOutputChunk: (chunk, stream) => {
          (stream === "stdout" ? process.stdout : process.stderr).write(chunk);
        },
      },
    );
    if (result.code !== 0) {
      throw new Error(
        "OpenShell worker node stopped unsuccessfully. Inspect the node and sandbox before restarting; no Gateway inference fallback was enabled.",
      );
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    // Piped exec has no remote cancellation. OpenShell stop joins the dedicated
    // sandbox's authoritative Stopped phase, even after an ambiguous exec error.
    const stopped = await runUtf8CommandWithTimeout([...argv, "sandbox", "stop", sandbox], {
      timeoutMs: plugin.timeoutMs,
      killProcessTree: true,
    });
    if (stopped.code !== 0) {
      throw new Error("OpenShell stop failed");
    }
  } catch (error) {
    failures.push(
      new Error(
        "OpenShell sandbox stop was not confirmed; the remote node may still be active. Inspect and stop this dedicated sandbox before retrying.",
        { cause: error },
      ),
    );
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      "OpenShell worker failed and sandbox stop was not confirmed; inspect and stop the dedicated sandbox before retrying.",
    );
  }
}

async function configureWorkerProfile(sandbox: string, options: WorkerOptions) {
  requireName(sandbox);
  const profile = options.profile?.trim();
  if (!profile || ["__proto__", "prototype", "constructor"].includes(profile)) {
    throw new Error("Supply an exact --profile name.");
  }
  const prepared = await readConfigFileSnapshotForWrite();
  if (!prepared.snapshot.valid) {
    throw new Error("Fix the Gateway configuration before configuring a worker profile.");
  }
  const source = prepared.snapshot.sourceConfig;
  const { plugin, worker } = requireWorker(prepared.snapshot.runtimeConfig);
  if (source.gateway?.mode === "remote") {
    throw new Error(
      "Run worker configure on the Gateway host; remote-mode local config is not the Gateway config.",
    );
  }
  const identity = await runUtf8CommandWithTimeout(
    [
      ...buildOpenShellBaseArgv(plugin),
      "sandbox",
      "exec",
      sandbox,
      "--no-tty",
      "--no-login-shell",
      "--env",
      "OPENCLAW_STATE_DIR=" + worker.stateDir,
      "--env",
      "OPENCLAW_CONFIG_PATH=" + path.posix.join(worker.stateDir, "openclaw.json"),
      "--",
      worker.nodeCommand,
      "node",
      "identity",
      "--json",
    ],
    { timeoutMs: plugin.timeoutMs, killProcessTree: true },
  );
  if (identity.code !== 0) {
    throw new Error(
      "Could not read the node identity inside this sandbox. Start and pair its worker node first.",
    );
  }
  let device: string;
  try {
    device = z
      .object({ deviceId: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(identity.stdout)).deviceId;
  } catch {
    throw new Error("OpenShell sandbox returned an invalid node identity.");
  }
  if (options.device && options.device.trim() !== device) {
    throw new Error(
      "The expected device does not match this OpenShell sandbox node. No configuration was changed.",
    );
  }
  const previous = source.cloudWorkers?.profiles?.[profile];
  if (
    previous &&
    (previous.provider !== "device" ||
      previous.settings?.device !== device ||
      previous.settings?.inference !== "worker")
  ) {
    throw new Error(
      "That profile already has a different worker binding. Reclaim its sessions and choose a new profile name; existing placements are not rewritten.",
    );
  }
  if (
    options.required &&
    source.cloudWorkers?.requiredProfile &&
    source.cloudWorkers.requiredProfile !== profile
  ) {
    throw new Error(
      "Another required worker profile is configured. Preserve it or remove it explicitly before changing the required destination.",
    );
  }
  const nextProfile = previous ?? { provider: "device", settings: { device, inference: "worker" } };
  if (options.apply) {
    await mutateConfigFile({
      base: "source",
      baseHash: prepared.snapshot.hash,
      writeOptions: prepared.writeOptions,
      afterWrite: { mode: "auto" },
      mutate: (draft) => {
        const workers = (draft.cloudWorkers ??= {});
        workers.profiles = { ...workers.profiles, [profile]: nextProfile };
        if (options.required) {
          workers.requiredProfile = profile;
        }
      },
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        applied: options.apply === true,
        cloudWorkers: {
          profiles: { [profile]: nextProfile },
          ...(options.required ? { requiredProfile: profile } : {}),
        },
        model: worker.model.provider + "/" + worker.model.id,
        next: "Use this model's non-secret metadata and the OpenClaw runtime on the Gateway. Device pairing, current availability, worker capability, and model admission are checked at dispatch. The device identity was read inside the selected sandbox; broker egress remains the OpenShell deployment trust contract.",
      },
      null,
      2,
    ) + "\n",
  );
}

export function registerOpenShellWorkerCli(program: Command, config: OpenClawConfig) {
  const worker = program
    .command("openshell")
    .description("Manage OpenShell brokered workers")
    .command("worker")
    .description("Run a native worker node inside an OpenShell sandbox");
  worker
    .command("create <sandbox>")
    .description("Create a retained broker-attached sandbox (never auto-import host credentials)")
    .action(async (sandbox: string) => {
      const { plugin } = requireWorker(config);
      requireName(sandbox);
      const result = await runUtf8CommandWithTimeout(
        [
          ...buildOpenShellBaseArgv(plugin),
          "sandbox",
          "create",
          "--name",
          sandbox,
          "--from",
          plugin.from,
          "--detach",
          "--no-auto-providers",
          ...(plugin.policy ? ["--policy", plugin.policy] : []),
          ...plugin.providers.flatMap((provider) => ["--provider", provider]),
          "--",
          "sleep",
          "infinity",
        ],
        { timeoutMs: Math.max(plugin.timeoutMs, 300000), killProcessTree: true },
      );
      if (result.code !== 0) {
        throw new Error(
          "OpenShell worker sandbox creation did not complete. Inspect the named sandbox before retrying; it has not been deleted or replaced.",
        );
      }
      process.stdout.write(
        "Sandbox created. Run openshell worker run with a private pairing target file to enroll its node. The sandbox is retained until explicitly stopped/deleted.\n",
      );
    });
  worker
    .command("run <sandbox>")
    .description("Run a dedicated brokered node; stops the entire sandbox on exit or cancellation")
    .option(
      "--target-file <path>",
      "Private local file containing a single-use OpenClaw join URL or setup code; never put it in argv",
    )
    .action((sandbox: string, options: WorkerOptions) =>
      runOpenShellWorker(config, sandbox, options),
    );
  worker
    .command("configure <sandbox>")
    .description("Preview or apply a paired-device worker-inference profile on this Gateway")
    .requiredOption("--profile <id>", "New Gateway worker profile name")
    .option("--device <id>", "Optional expected paired device ID; rejects a sandbox mismatch")
    .option("--required", "Require this profile for all sessions; unavailable workers block turns")
    .option("--apply", "Persist the displayed profile; otherwise leave configuration unchanged")
    .action(configureWorkerProfile);
}
