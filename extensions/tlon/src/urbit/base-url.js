import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/tlon";
function hasScheme(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}
function validateUrbitBaseUrl(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "Required" };
  }
  const candidate = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
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
  const isIpv6 = hostname.includes(":");
  const host = parsed.port ? `${isIpv6 ? `[${hostname}]` : hostname}:${parsed.port}` : isIpv6 ? `[${hostname}]` : hostname;
  return { ok: true, baseUrl: `${parsed.protocol}//${host}`, hostname };
}
function isBlockedUrbitHostname(hostname) {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized) {
    return false;
  }
  return isBlockedHostnameOrIp(normalized);
}
export {
  isBlockedUrbitHostname,
  validateUrbitBaseUrl
};
