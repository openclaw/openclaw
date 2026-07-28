import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { listSignalAccountIds, resolveSignalAccount } from "./accounts.js";
import { normalizeSignalEndpointAddress } from "./transport-policy.js";

type ManagedSignalEndpoint = {
  url: string;
  source: "connection" | "bind";
};

function normalizeEndpointHostname(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .replace(/%.+$/, "");
}

function endpointPort(url: URL): number {
  return url.port ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 80;
}

function endpointBasePath(url: URL): string {
  return url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
}

function localInterfaceAddresses(): Set<string> {
  const addresses = new Set(["127.0.0.1", "::1"]);
  try {
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        addresses.add(normalizeSignalEndpointAddress(entry.address));
      }
    }
  } catch {
    // Some restricted environments deny interface enumeration; loopback aliases still work.
  }
  return addresses;
}

async function resolveEndpointAddresses(endpointHostname: string): Promise<Set<string>> {
  const normalized = normalizeEndpointHostname(endpointHostname);
  const localAddresses = localInterfaceAddresses();
  if (normalized === "0.0.0.0" || normalized === "::") {
    return new Set([normalized]);
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return new Set(["127.0.0.1", "::1"]);
  }
  const localHostname = normalizeEndpointHostname(hostname());
  if (normalized === localHostname || normalized === `${localHostname}.local`) {
    return localAddresses;
  }
  if (isIP(normalized)) {
    return new Set([normalizeSignalEndpointAddress(normalized)]);
  }
  try {
    const records = await lookup(normalized, { all: true });
    return new Set(records.map((record) => normalizeSignalEndpointAddress(record.address)));
  } catch {
    return new Set();
  }
}

function wildcardBindMatchesEndpoint(
  bindHostname: string,
  candidateHostname: string,
  candidateAddresses: ReadonlySet<string>,
): boolean {
  const bind = normalizeEndpointHostname(bindHostname);
  if (bind !== "0.0.0.0" && bind !== "::") {
    return false;
  }
  const candidate = normalizeSignalEndpointAddress(candidateHostname);
  if (candidate === "localhost" || candidate.endsWith(".localhost")) {
    return true;
  }
  const localHostname = normalizeEndpointHostname(hostname());
  if (candidate === localHostname || candidate === `${localHostname}.local`) {
    return true;
  }
  // Wildcard binds own every local address in their family. In particular, 127/8
  // loopback aliases are valid sockets even when interface enumeration omits them.
  if (bind === "0.0.0.0") {
    const localAddresses = localInterfaceAddresses();
    return [...candidateAddresses].some(
      (address) =>
        (isIP(address) === 4 && address.startsWith("127.")) ||
        (isIP(address) === 4 && localAddresses.has(address)),
    );
  }
  const localAddresses = localInterfaceAddresses();
  return [...candidateAddresses].some(
    (address) =>
      address === "::1" ||
      (isIP(address) === 4 && address.startsWith("127.")) ||
      localAddresses.has(address),
  );
}

async function matchesManagedSignalEndpoint(
  managedEndpoint: ManagedSignalEndpoint,
  candidateEndpoint: string,
): Promise<boolean> {
  try {
    const managed = new URL(managedEndpoint.url);
    const candidate = new URL(candidateEndpoint);
    if (endpointBasePath(managed) !== endpointBasePath(candidate)) {
      return false;
    }
    if (managed.origin === candidate.origin) {
      return true;
    }
    if (
      managed.protocol !== candidate.protocol ||
      endpointPort(managed) !== endpointPort(candidate)
    ) {
      return false;
    }
    const candidateAddresses = await resolveEndpointAddresses(candidate.hostname);
    if (wildcardBindMatchesEndpoint(managed.hostname, candidate.hostname, candidateAddresses)) {
      return true;
    }
    const managedHostname = normalizeEndpointHostname(managed.hostname);
    const candidateHostname = normalizeEndpointHostname(candidate.hostname);
    if (managedHostname === candidateHostname) {
      return true;
    }
    if (
      managedEndpoint.source === "connection" &&
      !isIP(managedHostname) &&
      !isIP(candidateHostname)
    ) {
      // Shared proxy addresses do not make distinct virtual-host names equivalent.
      return false;
    }
    const managedAddresses = await resolveEndpointAddresses(managed.hostname);
    return [...managedAddresses].some((address) => candidateAddresses.has(address));
  } catch {
    return false;
  }
}

function formatSignalEndpointHost(host: string): string {
  const normalized = normalizeEndpointHostname(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function listConfiguredManagedSignalEndpoints(cfg: OpenClawConfig): ManagedSignalEndpoint[] {
  const managedEndpoints: ManagedSignalEndpoint[] = [];
  for (const accountId of listSignalAccountIds(cfg)) {
    const account = resolveSignalAccount({ cfg, accountId });
    if (!account.enabled || !account.configured || account.transport.kind !== "managed-native") {
      continue;
    }
    const configuredTransport = account.config.transport;
    const endpoints = new Map<string, ManagedSignalEndpoint>();
    if (configuredTransport?.kind === "managed-native" && configuredTransport.url) {
      endpoints.set(configuredTransport.url, {
        url: configuredTransport.url,
        source: "connection",
      });
    }
    const bindUrl = `http://${formatSignalEndpointHost(account.transport.httpHost)}:${account.transport.httpPort}`;
    // Bind ownership is stronger than connection URL identity when both normalize
    // to the same endpoint: DNS aliases would still reach the daemon OpenClaw stops.
    endpoints.set(bindUrl, { url: bindUrl, source: "bind" });
    managedEndpoints.push(...endpoints.values());
  }
  return managedEndpoints;
}

export async function aliasesManagedSignalEndpoint(
  cfg: OpenClawConfig,
  candidateUrl: string,
): Promise<boolean> {
  for (const managedEndpoint of listConfiguredManagedSignalEndpoints(cfg)) {
    if (await matchesManagedSignalEndpoint(managedEndpoint, candidateUrl)) {
      return true;
    }
  }
  return false;
}
