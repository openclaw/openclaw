// RI-026 Block 1.5 item #1 — outbound proxy sidecar for allowlist network policy.
//
// When a NetworkPolicy has `mode: "allowlist"`, strict enforcement requires
// routing all outbound traffic from the sandbox container through a tinyproxy
// sidecar that rejects CONNECT requests to hosts outside the allowlist. This
// module owns the proxy container's config + lifecycle. It does NOT decide
// whether a proxy is needed — that's `network-policy.ts`'s job — and it does
// NOT spawn the sandbox — that's `docker.ts`'s job.
//
// Architecture:
//   1. Per-agent user-defined Docker bridge network with `--internal` (no
//      direct external routing).
//   2. Tinyproxy container attached to BOTH the internal bridge (to receive
//      requests from the sandbox) AND the default bridge (to egress). Config
//      written as `Allow <host>` directives for each entry in
//      `policy.allowedHosts`.
//   3. Sandbox container attached ONLY to the internal bridge; also receives
//      `HTTP_PROXY` / `HTTPS_PROXY` env vars pointed at the proxy's internal
//      hostname. Direct egress is impossible because the internal network has
//      no external route.
//
// Tinyproxy image pin: `dannydirect/tinyproxy:latest`. Under ~5MB, maintained,
// native allowlist via `Allow` directive. If this image becomes unavailable
// we can swap to a minimal self-built alpine+tinyproxy.
//
// Scope note: This module manages proxy containers for the MAIN sandbox only.
// Browser sandbox + allowlist remains a follow-up (`ensureSandboxBrowser`
// has its own network lifecycle; wiring proxy for it requires a second pass).

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { NetworkPolicy } from "./network-policy.js";

const log = createSubsystemLogger("sandbox/outbound-proxy");

export const DEFAULT_OUTBOUND_PROXY_IMAGE = "dannydirect/tinyproxy:latest";
export const DEFAULT_OUTBOUND_PROXY_PORT = 8888;
export const OUTBOUND_PROXY_NETWORK_PREFIX = "openclaw-allowlist-";
export const OUTBOUND_PROXY_CONTAINER_PREFIX = "openclaw-proxy-";

export interface OutboundProxyBinding {
  /** User-defined internal Docker network name. Sandbox joins this network. */
  internalNetwork: string;
  /** Proxy container name (also its hostname inside the internal network). */
  proxyContainer: string;
  /** Proxy image tag pinned for reproducibility. */
  image: string;
  /** Host:port the sandbox should set as `HTTP_PROXY` / `HTTPS_PROXY`. */
  proxyUrl: string;
  /** Env-var map that must flow into the sandbox container spawn. */
  env: Record<string, string>;
  /** Human-readable note suitable for logging. */
  note: string;
}

/**
 * Slugify an agent id into a safe Docker resource name fragment.
 * Docker network names allow [a-zA-Z0-9][a-zA-Z0-9_.-]*. Agent ids coming in
 * are already validated by `loadNetworkPolicyForAgent` but may have mixed
 * case / punctuation; lowercase + strip to the safe charset here.
 */
function slugifyAgentId(agentId: string): string {
  const trimmed = agentId.trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "unknown";
}

export function resolveOutboundProxyNames(agentId: string): {
  internalNetwork: string;
  proxyContainer: string;
} {
  const slug = slugifyAgentId(agentId);
  return {
    internalNetwork: `${OUTBOUND_PROXY_NETWORK_PREFIX}${slug}`,
    proxyContainer: `${OUTBOUND_PROXY_CONTAINER_PREFIX}${slug}`,
  };
}

export interface TinyproxyConfigFiles {
  /** Contents of `/etc/tinyproxy/tinyproxy.conf` inside the container. */
  configBody: string;
  /** Contents of `/etc/tinyproxy/filter` inside the container — one host regex per line. */
  filterBody: string;
}

/**
 * Generate the two tinyproxy files required to enforce a hostname allowlist:
 *   - `tinyproxy.conf` with core settings + `Filter "/etc/tinyproxy/filter"` +
 *     `FilterDefaultDeny Yes` so only listed hosts pass.
 *   - `filter` with one regex-literal host per line, quoted to anchor.
 *
 * `ConnectPort` directives are emitted for the two standard HTTPS-tunneling
 * ports so CONNECT for allowlisted HTTPS hosts works. The filter applies to
 * both plain HTTP and CONNECT, so the allowlist is the single source of truth.
 */
export function renderTinyproxyConfig(policy: NetworkPolicy): TinyproxyConfigFiles {
  if (policy.mode !== "allowlist") {
    throw new Error(
      `renderTinyproxyConfig called with non-allowlist policy (mode=${policy.mode})`,
    );
  }
  const hosts = (policy.allowedHosts ?? []).map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    throw new Error(
      `Cannot render tinyproxy config for agent "${policy.agentId}" — allowedHosts is empty`,
    );
  }
  // User/Group must match a user that exists in the dannydirect/tinyproxy
  // image (`tinyproxy:tinyproxy`, uid 100 gid 101). `nobody`/`nogroup` are
  // NOT present in this Alpine image — tinyproxy will fail at setgid if we
  // ask for them. MaxClients/server-pool directives are required: the
  // compiled-in default for MaxClients is 0, which makes `child_pool_create`
  // abort with "MaxClients must be greater than zero" before any requests
  // are served. Verified live against dannydirect/tinyproxy:latest 2026-04-12.
  const configBody = [
    `# Generated by OpenClaw outbound-proxy for agent "${policy.agentId}"`,
    `# Mode: allowlist`,
    `# Host count: ${hosts.length}`,
    ``,
    `User tinyproxy`,
    `Group tinyproxy`,
    `Port ${DEFAULT_OUTBOUND_PROXY_PORT}`,
    `Listen 0.0.0.0`,
    `Timeout 600`,
    `DefaultErrorFile "/usr/share/tinyproxy/default.html"`,
    `LogLevel Info`,
    ``,
    `MaxClients 100`,
    `MinSpareServers 5`,
    `MaxSpareServers 20`,
    `StartServers 10`,
    `MaxRequestsPerChild 0`,
    ``,
    `# Hostname allowlist — deny everything not matched by /etc/tinyproxy/filter`,
    `Filter "/etc/tinyproxy/filter"`,
    `FilterCaseSensitive No`,
    `FilterDefaultDeny Yes`,
    `FilterExtended On`,
    `FilterURLs Off`,
    ``,
    `# CONNECT tunneling (HTTPS) — filter still applies to the destination host`,
    `ConnectPort 443`,
    `ConnectPort 563`,
    ``,
  ].join("\n");
  // Anchor each host pattern so "api.example.com" does not also match
  // "apiXexample.com". Tinyproxy treats the filter lines as POSIX extended
  // regexes when FilterExtended=On; we escape dots and anchor with ^/$.
  const escapeHost = (h: string) => h.replace(/[.]/g, "\\.").replace(/[^a-zA-Z0-9._\-\\]/g, "");
  const filterBody = hosts.map((h) => `^${escapeHost(h)}$`).join("\n") + "\n";
  return { configBody, filterBody };
}

/**
 * Pure data-plane resolver: maps a network policy to the binding shape the
 * spawn code needs. Does NOT touch Docker — that's `ensureOutboundProxy`'s
 * job (in a separate function that talks to execDocker). Kept pure so it is
 * trivially unit-testable.
 */
export function resolveOutboundProxyBinding(
  policy: NetworkPolicy,
  options?: { image?: string; port?: number },
): OutboundProxyBinding {
  if (policy.mode !== "allowlist") {
    throw new Error(
      `resolveOutboundProxyBinding called with non-allowlist policy (mode=${policy.mode})`,
    );
  }
  const image = options?.image ?? DEFAULT_OUTBOUND_PROXY_IMAGE;
  const port = options?.port ?? DEFAULT_OUTBOUND_PROXY_PORT;
  const { internalNetwork, proxyContainer } = resolveOutboundProxyNames(policy.agentId);
  const proxyUrl = `http://${proxyContainer}:${port}`;
  const hostCount = (policy.allowedHosts ?? []).length;
  return {
    internalNetwork,
    proxyContainer,
    image,
    proxyUrl,
    env: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    },
    note: `allowlist proxy for "${policy.agentId}" via ${proxyContainer}:${port} (${hostCount} hosts)`,
  };
}

/**
 * Thin adapter type around `docker` CLI operations. Lets callers (tests,
 * integration tests, production) inject a docker runner without this module
 * importing `child_process` directly — mirrors the pattern used elsewhere
 * in `src/agents/sandbox/`.
 */
export interface OutboundProxyDocker {
  networkExists(name: string): Promise<boolean>;
  createInternalNetwork(name: string): Promise<void>;
  containerRunning(name: string): Promise<boolean>;
  containerExists(name: string): Promise<boolean>;
  removeContainer(name: string): Promise<void>;
  runTinyproxyContainer(params: {
    name: string;
    image: string;
    internalNetwork: string;
    port: number;
    configBody: string;
    filterBody: string;
  }): Promise<void>;
  attachToBridge(name: string): Promise<void>;
}

export interface EnsureOutboundProxyResult {
  binding: OutboundProxyBinding;
  created: boolean;
  reused: boolean;
}

/**
 * Idempotently materialize the proxy container + internal network for an
 * allowlist policy. Safe to call on every sandbox spawn — if the network and
 * container already exist and the config hasn't drifted, returns the existing
 * binding. If the config changed the container is rebuilt with a new config.
 *
 * Docker I/O is delegated to the `docker` adapter for testability.
 */
export async function ensureOutboundProxy(params: {
  policy: NetworkPolicy;
  docker: OutboundProxyDocker;
  options?: { image?: string; port?: number };
}): Promise<EnsureOutboundProxyResult> {
  const { policy, docker } = params;
  if (policy.mode !== "allowlist") {
    throw new Error(
      `ensureOutboundProxy called with non-allowlist policy (mode=${policy.mode})`,
    );
  }
  const binding = resolveOutboundProxyBinding(policy, params.options);
  const { configBody, filterBody } = renderTinyproxyConfig(policy);

  if (!(await docker.networkExists(binding.internalNetwork))) {
    log.info(`Creating internal network ${binding.internalNetwork}`);
    await docker.createInternalNetwork(binding.internalNetwork);
  }

  const alreadyExists = await docker.containerExists(binding.proxyContainer);
  let created = false;
  let reused = false;
  if (alreadyExists) {
    const running = await docker.containerRunning(binding.proxyContainer);
    if (running) {
      reused = true;
      log.info(`Reusing running proxy container ${binding.proxyContainer}`);
    } else {
      log.warn(
        `Proxy container ${binding.proxyContainer} exists but is stopped — removing and recreating`,
      );
      await docker.removeContainer(binding.proxyContainer);
    }
  }
  if (!reused) {
    log.info(`Starting proxy container ${binding.proxyContainer} from ${binding.image}`);
    await docker.runTinyproxyContainer({
      name: binding.proxyContainer,
      image: binding.image,
      internalNetwork: binding.internalNetwork,
      port: DEFAULT_OUTBOUND_PROXY_PORT,
      configBody,
      filterBody,
    });
    await docker.attachToBridge(binding.proxyContainer);
    created = true;
  }

  return { binding, created, reused };
}
