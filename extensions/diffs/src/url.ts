import os from "node:os";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

const DEFAULT_GATEWAY_PORT = 18789;

export function buildViewerUrl(params: {
  config: OpenClawConfig;
  viewerPath: string;
  baseUrl?: string;
}): string {
  const baseUrl = params.baseUrl?.trim() || resolveGatewayBaseUrl(params.config);
  const normalizedBase = normalizeViewerBaseUrl(baseUrl);
  const normalizedPath = params.viewerPath.startsWith("/")
    ? params.viewerPath
    : `/${params.viewerPath}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function normalizeViewerBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid baseUrl: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`baseUrl must use http or https: ${raw}`);
  }
  const withoutTrailingSlash = parsed.toString().replace(/\/+$/, "");
  return withoutTrailingSlash;
}

function resolveGatewayBaseUrl(config: OpenClawConfig): string {
  const scheme = config.gateway?.tls?.enabled ? "https" : "http";
  const port =
    typeof config.gateway?.port === "number" ? config.gateway.port : DEFAULT_GATEWAY_PORT;
  const bind = config.gateway?.bind ?? "loopback";

  if (bind === "custom" && config.gateway?.customBindHost?.trim()) {
    return `${scheme}://${config.gateway.customBindHost.trim()}:${port}`;
  }

  if (bind === "lan") {
    return `${scheme}://${pickPrimaryLanIPv4() ?? "127.0.0.1"}:${port}`;
  }

  if (bind === "tailnet") {
    return `${scheme}://${pickPrimaryTailnetIPv4() ?? "127.0.0.1"}:${port}`;
  }

  return `${scheme}://127.0.0.1:${port}`;
}

function pickPrimaryLanIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  const preferredNames = ["en0", "eth0"];

  for (const name of preferredNames) {
    const candidate = pickPrivateAddress(nets[name]);
    if (candidate) {
      return candidate;
    }
  }

  for (const entries of Object.values(nets)) {
    const candidate = pickPrivateAddress(entries);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

function pickPrimaryTailnetIPv4(): string | undefined {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    const candidate = entries?.find((entry) => isTailnetIPv4(entry.address) && !entry.internal);
    if (candidate?.address) {
      return candidate.address;
    }
  }
  return undefined;
}

function pickPrivateAddress(entries: os.NetworkInterfaceInfo[] | undefined): string | undefined {
  return entries?.find(
    (entry) => entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address),
  )?.address;
}

function isPrivateIPv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isTailnetIPv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) {
    return false;
  }
  const [a, b] = octets;
  return a === 100 && b >= 64 && b <= 127;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets;
}
