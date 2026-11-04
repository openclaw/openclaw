import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { WorkerResourceReceipt } from "openclaw/plugin-sdk/plugin-entry";
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
  prepareGatewayAwsGuestBoundary,
  isGatewayAwsGuestReceipt,
} from "./crabbox-worker-gateway-aws.js";
import type { GuestNetworkBinding } from "./crabbox-worker-guest-network.js";
import { CRABBOX_CONFIG_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

export async function loadCrabboxConfigShow(params: {
  binary: string;
  signal?: AbortSignal;
  provider?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<unknown> {
  const result = await runCrabboxCommand({
    action: "config show",
    args: ["config", "show", "--json", ...(params.provider ? ["--provider", params.provider] : [])],
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
    ...process.env,
    ...env,
    // A nonempty CSV with no names overrides configured/profile allowlists in Crabbox.
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
  cliVersion?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<NodeJS.ProcessEnv> {
  params.assertCurrent();
  if (params.provider !== "aws") {
    throw new WorkerProviderError(
      "Crabbox provider/route is not qualified: Gateway-only guests initially require direct AWS Linux allocation",
    );
  }
  if (!params.cliVersion || !/^v?\d+\.\d+\.\d+$/u.test(params.cliVersion.trim())) {
    throw new WorkerProviderError(
      "Guest mode requires an operator-selected released Crabbox executable; development/candidate binaries are not qualified",
    );
  }
  const env = createCrabboxGuestCommandEnv(params.env);
  const config = await loadCrabboxConfigShow({ ...params, env });
  params.assertCurrent();
  const view = isRecord(config) ? config : undefined;
  if (view?.provider !== "aws" || view.brokerMode !== "direct" || view.coordinator) {
    throw new WorkerProviderError(
      "Gateway-only guest mode does not qualify managed or ambiguous Crabbox allocation routes",
    );
  }
  if (!isRecord(view?.aws) || view.aws.instanceProfile !== "" || view.tailscale !== false) {
    throw new WorkerProviderError("AWS guests require no instance profile or Tailscale bootstrap");
  }
  const forwarding = isRecord(view?.env) ? view.env : undefined;
  const cache = isRecord(view?.cache) ? view.cache : undefined;
  if (
    !Array.isArray(forwarding?.allow) ||
    forwarding.allow.length ||
    !cache ||
    ["pnpm", "npm", "docker", "git"].some((key) => cache[key] !== false) ||
    !Array.isArray(cache.volumes) ||
    cache.volumes.length
  ) {
    throw new WorkerProviderError(
      "Released Crabbox must confirm empty guest environment forwarding and disabled caches/volumes",
    );
  }
  return env;
}

export async function prepareCrabboxGuestNetwork(params: {
  binary: string;
  provider: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
  configureMetadata?: true;
  resourceReceipt?: WorkerResourceReceipt;
  recordResourceReceipt?: (receipt: WorkerResourceReceipt) => Promise<void>;
}): Promise<GuestNetworkBinding> {
  params.assertCurrent();
  if (!params.configureMetadata && !isGatewayAwsGuestReceipt(params.resourceReceipt)) {
    throw new WorkerProviderError(
      "Guest access requires a qualified Gateway-owned AWS resource receipt",
    );
  }
  const config = await loadCrabboxConfigShow(params);
  params.assertCurrent();
  const boundary = await prepareGatewayAwsGuestBoundary(config, params);
  params.assertCurrent();
  return { ...params, boundary, receipt: params.resourceReceipt };
}

/** Compose trusted guest allocation inputs once; workload/profile admission remains core-owned. */
export async function prepareCrabboxGuestAllocation(params: {
  binary: string;
  cliVersion?: string;
  provider: string;
  target: string;
  untrustedWorkload?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  assertCurrent: () => void;
  resourceReceipt?: WorkerResourceReceipt;
  recordResourceReceipt?: (receipt: WorkerResourceReceipt) => Promise<void>;
}): Promise<{ env: NodeJS.ProcessEnv; network: GuestNetworkBinding } | undefined> {
  if (!params.untrustedWorkload) {
    return undefined;
  }
  if (params.target !== "linux") {
    throw new WorkerProviderError(
      "Gateway-only AWS guest mode has not qualified this OS; use a Linux worker profile",
    );
  }
  const env = await prepareCrabboxGuestIsolation(params);
  const network = await prepareCrabboxGuestNetwork({ ...params, env, configureMetadata: true });
  params.assertCurrent();
  return { env, network };
}
