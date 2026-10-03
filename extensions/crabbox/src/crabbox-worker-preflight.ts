import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import {
  isRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  crabboxCommandOutput,
  parseCrabboxJson,
  type CrabboxCommandRunner,
  runCrabboxCommand,
} from "./crabbox-worker-command.js";
import { CRABBOX_CONFIG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

async function loadCrabboxConfigShow(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<unknown> {
  params.assertCurrent();
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json"],
    binary: params.binary,
    runCommand: params.runCommand,
    signal: params.signal,
    timeoutMs: CRABBOX_CONFIG_TIMEOUT_MS,
  });
  params.assertCurrent();
  return parseCrabboxJson(crabboxCommandOutput("config show", result), "config show");
}

export async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const instanceProfile =
    isRecord(config) && isRecord(config.aws) ? config.aws.instanceProfile : undefined;
  if (typeof instanceProfile !== "string") {
    throw new WorkerProviderError("Crabbox config show returned an invalid AWS instance profile");
  }
  if (nonEmptyString(instanceProfile)) {
    throw new WorkerProviderError("Crabbox AWS instance profile must be empty for cloud workers");
  }
}

export async function assertHetznerDesktopHasManagedCoordinator(params: {
  binary: string;
  runCommand: CrabboxCommandRunner;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const view = isRecord(config) ? config : undefined;
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new Error("Crabbox Hetzner desktop profiles require a managed coordinator");
}
