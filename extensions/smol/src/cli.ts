import {
  runPluginCommandWithTimeout,
  type PluginCommandRunResult,
} from "openclaw/plugin-sdk/sandbox";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ResolvedSmolPluginConfig } from "./config.js";

/** Runs one smol CLI invocation; injected so unit tests never spawn a process. */
export type SmolCommandRunner = (
  argv: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<PluginCommandRunResult>;

export type SmolCliContext = {
  config: ResolvedSmolPluginConfig;
  run?: SmolCommandRunner;
};

export type SmolMachineSummary = {
  name: string;
  state: string;
  image?: string;
};

export type SmolMachineStatus = {
  running: boolean;
  network: boolean;
};

export const defaultSmolCommandRunner: SmolCommandRunner = (argv, options) =>
  runPluginCommandWithTimeout({ argv, timeoutMs: options.timeoutMs, env: options.env });

/**
 * The CLI runs machines on the local engine unless told otherwise. A cloud
 * token in the Gateway's environment must never move a sandbox that mounts the
 * Gateway host's workspace onto someone else's hardware.
 */
export function smolCommandEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { SMOL_CLOUD_TOKEN: _token, ...env } = base;
  return env;
}

/** Lifecycle argv: `smol machine <verb> --name <machine> ...` */
export function buildSmolMachineArgv(
  config: ResolvedSmolPluginConfig,
  verb: string,
  machineName: string,
  args: readonly string[] = [],
): string[] {
  return [config.command, "machine", verb, "--name", machineName, ...args];
}

export async function runSmolCli(
  context: SmolCliContext,
  argv: string[],
  timeoutMs = context.config.timeoutMs,
): Promise<PluginCommandRunResult> {
  const run = context.run ?? defaultSmolCommandRunner;
  return await run(argv, { timeoutMs, env: smolCommandEnv() });
}

export function formatSmolCliFailure(action: string, result: PluginCommandRunResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  return `smol ${action} failed: ${detail}`;
}

/**
 * `machine ls --json --local` prints one array. It reports the resolved image
 * under `source`; the engine CLI (`smolvm`) calls it `image`.
 */
export function parseSmolMachineList(stdout: string): SmolMachineSummary[] {
  const parsed = safeParseJson(stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const summaries: SmolMachineSummary[] = [];
  for (const entry of parsed) {
    const record = asOptionalRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.state !== "string") {
      continue;
    }
    const image = typeof record.source === "string" ? record.source : record.image;
    summaries.push({
      name: record.name,
      state: record.state,
      image: typeof image === "string" ? image : undefined,
    });
  }
  return summaries;
}

export async function describeSmolMachine(
  context: SmolCliContext,
  machineName: string,
): Promise<SmolMachineSummary | undefined> {
  const result = await runSmolCli(context, [
    context.config.command,
    "machine",
    "ls",
    "--json",
    "--local",
  ]);
  if (result.code !== 0) {
    throw new Error(formatSmolCliFailure("machine ls", result));
  }
  return parseSmolMachineList(result.stdout).find((machine) => machine.name === machineName);
}

/**
 * The CLI records the image it resolved, often pinned by digest. Treat a
 * configured reference as matching when it names the same repository and tag.
 */
export function smolImageReferencesMatch(actual: string | undefined, configured: string): boolean {
  if (!actual) {
    return false;
  }
  return normalizeImageReference(actual) === normalizeImageReference(configured);
}

function normalizeImageReference(reference: string): string {
  const withoutDigest = reference.split("@")[0] ?? reference;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(lastColon + 1) : "latest";
  const qualified = repository.includes("/") ? repository : `library/${repository}`;
  const withRegistry = qualified.split("/")[0]?.includes(".")
    ? qualified
    : `docker.io/${qualified}`;
  return `${withRegistry}:${tag}`;
}

/** `machine status --json` is the only place the CLI reports a machine's network setting. */
export function parseSmolMachineStatus(stdout: string): SmolMachineStatus | undefined {
  const record = asOptionalRecord(safeParseJson(stdout));
  if (!record || typeof record.running !== "boolean" || typeof record.network !== "boolean") {
    return undefined;
  }
  return { running: record.running, network: record.network };
}

export async function describeSmolMachineStatus(
  context: SmolCliContext,
  machineName: string,
): Promise<SmolMachineStatus> {
  const result = await runSmolCli(
    context,
    buildSmolMachineArgv(context.config, "status", machineName, ["--local", "--json"]),
  );
  if (result.code !== 0) {
    throw new Error(formatSmolCliFailure("machine status", result));
  }
  const status = parseSmolMachineStatus(result.stdout);
  if (!status) {
    throw new Error(`smol machine status returned no network state for ${machineName}`);
  }
  return status;
}
