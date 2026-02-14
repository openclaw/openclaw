import { isBlockedHostname, isPrivateIpAddress } from "openclaw/plugin-sdk";

export type UrbitBaseUrlValidation =
  | { ok: true; baseUrl: string; hostname: string }
  | { ok: false; error: string };

function hasScheme(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

export function validateUrbitBaseUrl(raw: string): UrbitBaseUrlValidation {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "Required" };
  }

  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, error: "URL must use http:// or https://" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "URL must not include credentials" };
  }

  const hostname = parsed.hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname) {
    return { ok: false, error: "Invalid hostname" };
  }

  // Normalize to origin so callers can't smuggle paths/query fragments into the base URL.
  return { ok: true, baseUrl: parsed.origin, hostname };
}

export function isBlockedUrbitHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) {
    return false;
  }
  return isBlockedHostname(normalized) || isPrivateIpAddress(normalized);
}
