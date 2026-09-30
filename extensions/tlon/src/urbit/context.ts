import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";
export { ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "openclaw/plugin-sdk/ssrf-runtime";

type UrbitContext = {
  baseUrl: string;
  hostname: string;
  ship: string;
};

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
    ship: (
      ship?.replace(/^~/, "") ??
      validated.hostname.split(".")[0] ??
      validated.hostname
    ).trim(),
  };
}
