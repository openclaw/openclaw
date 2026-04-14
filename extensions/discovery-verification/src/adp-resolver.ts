/**
 * Agent Discovery Protocol (ADP) resolver.
 *
 * Fetches `/.well-known/agent-discovery.json` for a given domain and
 * normalizes the response into a `DiscoveryResult`. Hardened against
 * the obvious attacks an external `/.well-known` fetcher needs to
 * worry about:
 *
 *   - FQDN validation (no IP literals, no scheme injection, no userinfo)
 *   - SSRF: rejects private/reserved IP ranges before any I/O
 *   - Bounded body read (default 1 MiB) to prevent memory exhaustion
 *   - Schema validation BEFORE caching so a malformed payload can't
 *     poison the cache
 *
 * Returns:
 *   - `{ kind: "ok", result }` on success
 *   - `{ kind: "not-found" }` for authoritative 404/410 (negative-cacheable)
 *   - `{ kind: "transient" }` for timeouts / network errors / oversized
 *     bodies / malformed JSON / schema failures (NOT cached)
 *
 * The resolver never throws on network failure; it converts everything
 * to a result variant so the caller can decide whether to cache, retry,
 * or just log and move on.
 */

import dns from "node:dns/promises";
import {
  DEFAULT_RESOLVER_CONFIG,
  type AdpDiscoveryResult,
  type AdpService,
  type ResolverConfig,
} from "./types.js";

// FQDN regex: letters/digits/hyphens, dots, no leading/trailing hyphen,
// at least one TLD label. Mirrors the validation in the upstream Python
// reference implementation.
const FQDN_RE =
  /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,}$/;

// IPv4 + IPv6 ranges that must never be reachable for /.well-known/ fetches.
const BLOCKED_V4 = [
  // Loopback
  { net: parseV4("127.0.0.0"), bits: 8 },
  // Private (RFC 1918)
  { net: parseV4("10.0.0.0"), bits: 8 },
  { net: parseV4("172.16.0.0"), bits: 12 },
  { net: parseV4("192.168.0.0"), bits: 16 },
  // Link-local + cloud metadata (RFC 3927)
  { net: parseV4("169.254.0.0"), bits: 16 },
  // Carrier-grade NAT (RFC 6598)
  { net: parseV4("100.64.0.0"), bits: 10 },
  // 0.0.0.0/8
  { net: parseV4("0.0.0.0"), bits: 8 },
];

const BLOCKED_V6_PREFIXES = [
  "::1", // loopback
  "fc", // unique local fc00::/7
  "fd", // unique local
  "fe80", // link-local
];

export type ResolveOk = { readonly kind: "ok"; readonly result: AdpDiscoveryResult };
export type ResolveNotFound = { readonly kind: "not-found" };
export type ResolveTransient = { readonly kind: "transient"; readonly reason: string };
export type ResolveOutcome = ResolveOk | ResolveNotFound | ResolveTransient;

export interface AdpResolverDeps {
  /** DNS resolver. Pluggable for tests. */
  readonly resolveDns?: (host: string) => Promise<string[]>;
  /** Fetch implementation. Pluggable for tests. Must accept AbortSignal. */
  readonly fetchImpl?: typeof fetch;
  /** Clock function for cache TTLs. Default: `Date.now`. */
  readonly now?: () => number;
}

export interface ResolveAdpInput {
  readonly domain: string;
  readonly config?: Partial<ResolverConfig>;
  readonly deps?: AdpResolverDeps;
}

/** Public entry point. */
export async function resolveAdp(input: ResolveAdpInput): Promise<ResolveOutcome> {
  const cfg: ResolverConfig = { ...DEFAULT_RESOLVER_CONFIG, ...(input.config ?? {}) };
  const deps = input.deps ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  const resolveDns = deps.resolveDns ?? defaultResolveDns;

  const validationError = validateDomain(input.domain);
  if (validationError) {
    return { kind: "transient", reason: validationError };
  }

  // SSRF: every resolved IP must be public. Any private hit poisons
  // the entire lookup -- an attacker must not be able to mix one
  // private entry into a multi-A record.
  let ips: string[];
  try {
    ips = await resolveDns(input.domain);
  } catch (err) {
    return { kind: "transient", reason: `dns failure: ${describeError(err)}` };
  }
  if (ips.length === 0) {
    return { kind: "transient", reason: "dns returned no addresses" };
  }
  for (const ip of ips) {
    if (isBlockedIp(ip)) {
      return { kind: "transient", reason: `blocked address ${ip}` };
    }
  }

  // We rely on the runtime fetch's HTTPS hostname/SNI for cert
  // verification. We don't attempt the per-IP failover dance from
  // the Python reference here -- that's for the next commit.
  const url = `https://${input.domain}/.well-known/agent-discovery.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "openclaw-discovery-verification/0.1",
        Accept: "application/json",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return { kind: "transient", reason: `fetch failed: ${describeError(err)}` };
  }
  clearTimeout(timer);

  // Block redirects (SSRF bypass prevention).
  if (response.status >= 300 && response.status < 400) {
    return { kind: "transient", reason: `unexpected redirect ${response.status}` };
  }

  if (response.status === 404 || response.status === 410) {
    return { kind: "not-found" };
  }

  if (response.status < 200 || response.status >= 300) {
    return { kind: "transient", reason: `http ${response.status}` };
  }

  // Bounded body read so a hostile server can't OOM us.
  const contentLength = parseContentLength(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > cfg.maxBodyBytes) {
    return { kind: "transient", reason: `body too large (declared ${contentLength})` };
  }

  let body: string;
  try {
    body = await readBoundedText(response, cfg.maxBodyBytes);
  } catch (err) {
    return { kind: "transient", reason: `body read failed: ${describeError(err)}` };
  }
  if (body.length > cfg.maxBodyBytes) {
    return { kind: "transient", reason: "body exceeded cap" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (err) {
    return { kind: "transient", reason: `json parse failed: ${describeError(err)}` };
  }

  const validated = validateAdpPayload(payload, input.domain);
  if (!validated.ok) {
    return { kind: "transient", reason: validated.reason };
  }

  return { kind: "ok", result: validated.result };
}

// ---------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------

export function validateDomain(domain: string): string | null {
  if (typeof domain !== "string" || domain.length === 0) {
    return "domain must be a non-empty string";
  }
  if (domain.length > 253) {
    return "domain too long";
  }
  if (!FQDN_RE.test(domain)) {
    return `invalid domain format: ${domain}`;
  }
  return null;
}

interface PayloadOk {
  readonly ok: true;
  readonly result: AdpDiscoveryResult;
}
interface PayloadFail {
  readonly ok: false;
  readonly reason: string;
}

export function validateAdpPayload(
  payload: unknown,
  fallbackDomain: string,
): PayloadOk | PayloadFail {
  if (!isPlainObject(payload)) {
    return { ok: false, reason: "ADP payload must be a JSON object" };
  }

  const rawServices = payload["services"];
  let services: AdpService[] = [];
  if (rawServices !== undefined) {
    if (!Array.isArray(rawServices)) {
      return { ok: false, reason: "ADP 'services' field must be an array" };
    }
    for (const entry of rawServices) {
      if (!isPlainObject(entry)) {
        return { ok: false, reason: "ADP service entries must be objects" };
      }
      const name = entry["name"];
      if (typeof name !== "string" || name.trim() === "") {
        return {
          ok: false,
          reason: "ADP service entries must have a non-empty string 'name' field",
        };
      }
      services.push({
        name,
        description: typeof entry["description"] === "string" ? entry["description"] : undefined,
        endpoint: typeof entry["endpoint"] === "string" ? entry["endpoint"] : undefined,
        auth: typeof entry["auth"] === "string" ? entry["auth"] : undefined,
        governance: typeof entry["governance"] === "string" ? entry["governance"] : undefined,
        free_tier: typeof entry["free_tier"] === "boolean" ? entry["free_tier"] : undefined,
      });
    }
  }

  const domain =
    typeof payload["domain"] === "string" && payload["domain"].length > 0
      ? (payload["domain"] as string)
      : fallbackDomain;
  const version =
    typeof payload["agent_discovery_version"] === "string"
      ? (payload["agent_discovery_version"] as string)
      : "";
  const trust = isPlainObject(payload["trust"])
    ? (payload["trust"] as Record<string, unknown>)
    : undefined;

  return {
    ok: true,
    result: {
      format: "adp",
      domain,
      version,
      services,
      trust,
      raw: payload as Record<string, unknown>,
    },
  };
}

// ---------------------------------------------------------------------
// SSRF: IP block list
// ---------------------------------------------------------------------

export function isBlockedIp(ip: string): boolean {
  // IPv6
  if (ip.includes(":")) {
    const lower = ip.toLowerCase();
    for (const prefix of BLOCKED_V6_PREFIXES) {
      if (lower === prefix) return true;
      if (lower.startsWith(prefix + ":")) return true;
    }
    // ::ffff:1.2.3.4 -- IPv4-mapped, treat as the embedded v4
    const v4Match = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4Match) {
      return isBlockedV4(v4Match[1]);
    }
    return false;
  }
  return isBlockedV4(ip);
}

function isBlockedV4(ip: string): boolean {
  const parsed = parseV4(ip);
  if (parsed === null) return true; // garbage -> block
  for (const { net, bits } of BLOCKED_V4) {
    if (net === null) continue;
    if (sameSubnet(parsed, net, bits)) return true;
  }
  return false;
}

function parseV4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const num = Number(part);
    if (num < 0 || num > 255) return null;
    acc = (acc << 8) | num;
  }
  return acc >>> 0;
}

function sameSubnet(a: number, b: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (a & mask) === (b & mask);
}

// ---------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------

async function defaultResolveDns(host: string): Promise<string[]> {
  // dns.lookup returns the system-resolver result (matches what the
  // HTTPS client will see for the actual connect). We deliberately
  // avoid dns.resolve4/6 which bypass /etc/hosts and DNS-over-HTTPS
  // configurations.
  const all = await dns.lookup(host, { all: true, verbatim: true });
  return all.map((r) => r.address);
}

async function readBoundedText(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Some fetch implementations don't expose body as a stream;
    // fall back to text() but enforce the cap after.
    const text = await response.text();
    return text.slice(0, max + 1);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total > max) {
        try {
          await reader.cancel();
        } catch {
          // noop
        }
        return new TextDecoder("utf-8").decode(concatBytes(chunks)).slice(0, max + 1);
      }
    }
  }
  return new TextDecoder("utf-8").decode(concatBytes(chunks));
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
