import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";
function resolveShipFromHostname(hostname) {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.includes(".")) {
    return trimmed.split(".")[0] ?? trimmed;
  }
  return trimmed;
}
function normalizeUrbitShip(ship, hostname) {
  const raw = ship?.replace(/^~/, "") ?? resolveShipFromHostname(hostname);
  return raw.trim();
}
function normalizeUrbitCookie(cookie) {
  return cookie.split(";")[0] ?? cookie;
}
function getUrbitContext(url, ship) {
  const validated = validateUrbitBaseUrl(url);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }
  return {
    baseUrl: validated.baseUrl,
    hostname: validated.hostname,
    ship: normalizeUrbitShip(ship, validated.hostname)
  };
}
function ssrfPolicyFromAllowPrivateNetwork(allowPrivateNetwork) {
  return allowPrivateNetwork ? { allowPrivateNetwork: true } : void 0;
}
function getDefaultSsrFPolicy() {
  return void 0;
}
export {
  getDefaultSsrFPolicy,
  getUrbitContext,
  normalizeUrbitCookie,
  normalizeUrbitShip,
  resolveShipFromHostname,
  ssrfPolicyFromAllowPrivateNetwork
};
