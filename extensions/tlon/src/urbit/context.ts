import type { SsrFPolicy } from "openclaw/plugin-sdk";
import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";

export type UrbitContext = {
  baseUrl: string;
  hostname: string;
  ship: string;
};

export function resolveShipFromHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes(".")) {
    return trimmed.split(".")[0] ?? trimmed;
  }
  return trimmed;
}

export function normalizeUrbitShip(ship: string | undefined, hostname: string): string {
  const raw = ship?.replace(/^~/, "") ?? resolveShipFromHostname(hostname);
  return raw.trim();
}

export function normalizeUrbitCookie(cookie: string): string {
  return cookie.split(";")[0] ?? cookie;
}

export function getUrbitContext(url: string, ship?: string): UrbitContext {
  const validated = validateUrbitBaseUrl(url);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }
  return {
    baseUrl: validated.baseUrl,
    hostname: validated.hostname,
    ship: normalizeUrbitShip(ship, validated.hostname),
  };
}

export function ssrfPolicyFromAllowPrivateNetwork(
  allowPrivateNetwork: boolean | null | undefined,
): SsrFPolicy | undefined {
  return allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined;
}
