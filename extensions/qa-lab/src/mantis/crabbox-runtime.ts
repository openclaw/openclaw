import { spawn, type SpawnOptions } from "node:child_process";
import {
  ensureManagedCrabboxBinary,
  resolveCrabboxBinary,
} from "@openclaw/crabbox-provider/cli-runtime-api.js";
import { trimToValue } from "../mantis-options.runtime.js";

type CommandResult = {
  stderr: string;
  stdout: string;
};

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<CommandResult>;

export type CrabboxInspect = {
  host?: string;
  id?: string;
  provider?: string;
  ready?: boolean;
  slug?: string;
  sshFallbackPorts?: string[];
  sshHost?: string;
  sshKey?: string;
  sshPort?: string;
  sshUser?: string;
  state?: string;
};

export async function defaultCommandRunner(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (text: string) => {
      stdout += text;
      if (options.stdio === "inherit") {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (text: string) => {
      stderr += text;
      if (options.stdio === "inherit") {
        process.stderr.write(text);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(
        new Error(
          `${command} ${args.join(" ")} failed with ${detail}${stderr ? `\n${stderr.trimEnd()}` : ""}`,
        ),
      );
    });
  });
}

export async function resolveCrabboxBin(params: {
  env: NodeJS.ProcessEnv;
  envName: string;
  explicit?: string;
  repoRoot: string;
}) {
  const candidate = resolveCrabboxBinary({
    cwd: params.repoRoot,
    explicit: trimToValue(params.explicit) ?? trimToValue(params.env[params.envName]),
    openclawRoot: params.repoRoot,
    pathEnv: params.env.PATH,
  });
  const { binary } = await ensureManagedCrabboxBinary({
    binary: candidate,
    cwd: params.repoRoot,
    env: params.env,
  });
  return binary;
}

function extractLeaseId(output: string) {
  return output.match(/\b(?:cbx_[a-f0-9]+|tbx_[A-Za-z0-9_-]+)\b/u)?.[0];
}

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runCommand(params: {
  args: readonly string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  stdio?: "inherit" | "pipe";
}) {
  return params.runner(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: params.stdio ?? "pipe",
  });
}

export function createMantisCrabboxSession(params: {
  crabboxBin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  leaseId?: string;
  provider: string;
  runner: CommandRunner;
}) {
  let leaseId = params.leaseId;
  const createdLease = leaseId === undefined;
  const run = (args: readonly string[], stdio?: "inherit" | "pipe") =>
    runCommand({ ...params, command: params.crabboxBin, args, stdio });
  const requireLeaseId = () => {
    if (!leaseId) {
      throw new Error("Crabbox lease id is unavailable before acquisition.");
    }
    return leaseId;
  };
  return {
    createdLease,
    get leaseId() {
      return leaseId;
    },
    async acquire(options: {
      idleTimeout: string;
      machineClass: string;
      market?: string;
      ttl: string;
    }) {
      if (leaseId !== undefined) {
        return leaseId;
      }
      const result = await run(
        [
          "warmup",
          "--provider",
          params.provider,
          "--desktop",
          "--browser",
          "--class",
          options.machineClass,
          ...(options.market ? ["--market", options.market] : []),
          "--idle-timeout",
          options.idleTimeout,
          "--ttl",
          options.ttl,
        ],
        "inherit",
      );
      const acquired = extractLeaseId(`${result.stdout}\n${result.stderr}`);
      if (!acquired) {
        throw new Error("Crabbox warmup did not print a lease id.");
      }
      leaseId = acquired;
      return acquired;
    },
    async inspect() {
      const result = await run([
        "inspect",
        "--provider",
        params.provider,
        "--id",
        requireLeaseId(),
        "--json",
      ]);
      return JSON.parse(result.stdout) as CrabboxInspect;
    },
    describe(inspected?: CrabboxInspect) {
      return {
        bin: params.crabboxBin,
        createdLease,
        id: leaseId ?? "unallocated",
        provider: params.provider,
        ...(inspected ? { slug: inspected.slug, state: inspected.state } : {}),
        vncCommand: leaseId
          ? `${params.crabboxBin} vnc --provider ${params.provider} --id ${leaseId} --open`
          : "unallocated",
      };
    },
    async stop() {
      await run(["stop", "--provider", params.provider, requireLeaseId()], "inherit");
    },
  };
}

function crabboxSshPortCandidates(inspect: Pick<CrabboxInspect, "sshFallbackPorts" | "sshPort">) {
  const ports = [inspect.sshPort?.trim() || "22", ...(inspect.sshFallbackPorts ?? [])];
  return [...new Set(ports.map((port) => port.trim()).filter(Boolean))] as [string, ...string[]];
}

function isSshConnectionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Connection (?:closed|refused|reset|timed out)|Operation timed out|Network is unreachable|No route to host/u.test(
    message,
  );
}

function sshCommandForPort(inspect: CrabboxInspect, sshPort: string) {
  const host = inspect.sshHost || inspect.host;
  const { sshKey, sshUser } = inspect;
  if (!host || !sshKey || !sshUser) {
    throw new Error("Crabbox inspect output is missing SSH copy details.");
  }
  const options = [
    "-p",
    sshPort,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
  ];
  return {
    probeArgs: ["-i", sshKey, ...options, `${sshUser}@${host}`, "exit 0"],
    value: { host, sshArgs: ["ssh", "-i", shellQuote(sshKey), ...options].join(" "), sshUser },
  };
}

async function sshCommand(params: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  inspect: CrabboxInspect;
  runner: CommandRunner;
}) {
  const candidates = crabboxSshPortCandidates(params.inspect);
  if (candidates.length === 1) {
    return sshCommandForPort(params.inspect, candidates[0]).value;
  }

  let lastError: unknown;
  // Select the transport before rsync so a copy failure never replays the operation on another port.
  for (const port of candidates) {
    const command = sshCommandForPort(params.inspect, port);
    try {
      await runCommand({
        args: command.probeArgs,
        command: "ssh",
        cwd: params.cwd,
        env: params.env,
        runner: params.runner,
      });
      return command.value;
    } catch (error) {
      if (!isSshConnectionFailure(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

export async function copyCrabboxArtifacts(params: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  exclude?: readonly string[];
  inspect: CrabboxInspect;
  outputDir: string;
  remoteOutputDir: string;
  runner: CommandRunner;
}) {
  const { host, sshArgs, sshUser } = await sshCommand(params);
  const excludeArgs = params.exclude?.flatMap((pattern) => ["--exclude", pattern]) ?? [];
  await runCommand({
    command: "rsync",
    args: [
      "-az",
      "-e",
      sshArgs,
      ...excludeArgs,
      `${sshUser}@${host}:${params.remoteOutputDir}/`,
      `${params.outputDir}/`,
    ],
    cwd: params.cwd,
    env: params.env,
    runner: params.runner,
  });
}
