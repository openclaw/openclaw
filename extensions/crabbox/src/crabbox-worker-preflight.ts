import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import {
  isRecord,
  normalizeOptionalString as nonEmptyString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  crabboxCommandOutput,
  parseCrabboxJson,
  runCrabboxCommand,
} from "./crabbox-worker-command.js";
import {
  readGuestNetworkExpectation,
  type GuestNetworkBinding,
} from "./crabbox-worker-guest-network.js";
import { CRABBOX_CONFIG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

export async function loadCrabboxConfigShow(params: {
  binary: string;
  signal?: AbortSignal;
  provider?: string;
  guestNetworkServer?: boolean;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<unknown> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: [
      "config",
      "show",
      "--json",
      ...(params.guestNetworkServer ? ["--guest-network-server"] : []),
      ...(params.provider ? ["--provider", params.provider] : []),
    ],
    env: params.env,
    assertCurrent: params.assertCurrent,
    binary: params.binary,
    signal: params.signal,
    timeoutMs: CRABBOX_CONFIG_TIMEOUT_MS,
  });
  return parseCrabboxJson(crabboxCommandOutput("config show", result), "config show");
}

export async function assertAwsWorkerHasNoInstanceProfile(params: {
  binary: string;
  signal?: AbortSignal;
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
  signal?: AbortSignal;
}): Promise<void> {
  const config = await loadCrabboxConfigShow(params);
  const view = isRecord(config) ? config : undefined;
  if (nonEmptyString(view?.coordinator) && view?.brokerMode === "managed") {
    return;
  }
  throw new Error("Crabbox Hetzner desktop profiles require a managed coordinator");
}

/** The CLI keeps control-plane credentials, but forwards only explicitly named bootstrap inputs. */
export function createCrabboxGuestCommandEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    // A nonempty CSV with no names overrides configured/profile allowlists in Crabbox.
    CRABBOX_UNTRUSTED_WORKLOAD: "true",
    CRABBOX_ENV_ALLOW: ",",
    CRABBOX_CACHE_PNPM: "false",
    CRABBOX_CACHE_NPM: "false",
    CRABBOX_CACHE_DOCKER: "false",
    CRABBOX_CACHE_GIT: "false",
    CRABBOX_CACHE_VOLUMES: ",",
  };
}

export async function prepareCrabboxGuestIsolation(params: {
  binary: string;
  provider: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<NodeJS.ProcessEnv> {
  // Other drivers need their own identity/mount isolation contract, not an AWS inference.
  if (params.provider !== "aws") {
    throw new WorkerProviderError(
      "Guest isolation is not qualified for Crabbox provider " + params.provider,
    );
  }
  const env = params.env ?? createCrabboxGuestCommandEnv();
  const config = await loadCrabboxConfigShow({ ...params, env });
  params.assertCurrent();
  if (!isRecord(config) || config.provider !== params.provider) {
    throw new WorkerProviderError("Crabbox config does not match the requested guest provider");
  }
  const aws = isRecord(config) && isRecord(config.aws) ? config.aws : undefined;
  const cache = isRecord(config) && isRecord(config.cache) ? config.cache : undefined;
  if (!aws || typeof aws.instanceProfile !== "string" || aws.instanceProfile.trim()) {
    throw new WorkerProviderError("Guest machines cannot have an AWS instance profile");
  }
  if (
    !cache ||
    [cache.pnpm, cache.npm, cache.docker, cache.git].some((value) => value !== false) ||
    !(cache.volumes === null || (Array.isArray(cache.volumes) && cache.volumes.length === 0))
  ) {
    throw new WorkerProviderError(
      "Crabbox did not disable shared guest caches and volumes; use a supported CLI",
    );
  }
  return env;
}

/** Qualify the selected operator route; the CLI authenticates managed server policy before allocation. */
export async function prepareCrabboxGuestNetwork(params: {
  binary: string;
  provider: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<GuestNetworkBinding> {
  params.assertCurrent();
  let config = await loadCrabboxConfigShow(params);
  params.assertCurrent();
  if (
    isRecord(config) &&
    isRecord(config.guestNetworkCapability) &&
    config.guestNetworkCapability.allocationRoute === "managed-coordinator"
  ) {
    config = await loadCrabboxConfigShow({ ...params, guestNetworkServer: true });
    params.assertCurrent();
    const negotiated = readGuestNetworkExpectation(config);
    if (
      negotiated.allocationRoute !== "managed-coordinator" ||
      negotiated.policy.bootstrapMode !== "ssh-public-key-v1"
    ) {
      throw new WorkerProviderError(
        "Crabbox managed guest negotiation changed allocation route or bootstrap mode",
      );
    }
  }
  return { expected: readGuestNetworkExpectation(config) };
}
