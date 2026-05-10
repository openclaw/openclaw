/**
 * Centralized allow-list / deny-list gate for the Home Assistant bridge.
 *
 * Pure functions over `HomeAssistantConfig`. Two surfaces consume this gate:
 *   - the gateway bridge (Unit 4) for incoming service-call requests from the
 *     kiosk
 *   - any future agent-tool path that wants to call HA services through the
 *     same plugin
 *
 * Both go through `isEntityAllowed` and `checkServiceCall` so the household's
 * curated allow-list and deny-list are the single source of truth.
 *
 * V1 service-permission policy (deferred decision now resolved):
 *   - If a service is in `denyServiceList` -> denied.
 *   - Otherwise -> allowed.
 *
 * The HA-user-side deny-list documented in the Jarvis Butler plan is the
 * actual safety net (locks, alarm-disarm, garage-open are not exposed to the
 * `jarvis_kiosk` HA user at all). This client-side gate is belt-and-braces
 * so a tile bound to a forbidden service never even issues the call.
 *
 * Future hardening (deferred -- not in v1): add
 * `HomeAssistantConfig.allowServiceList`. When present + non-empty, the gate
 * switches to deny-by-default and requires services to be enumerated there.
 * The deny-list keeps precedence (deny wins over allow). The
 * "future hardening guard" test in allowlist.test.ts locks this contract.
 */

import type { HomeAssistantConfig } from "./config-schema.js";

export type ServiceDeniedReason = {
  kind: "service-denied";
  domain: string;
  service: string;
  detail: string;
};

export type ServiceCheckResult =
  | { allowed: true; domain: string; service: string }
  | { allowed: false; reason: ServiceDeniedReason };

const SEGMENT_PATTERN = /^[a-z][a-z0-9_]*$/;

function normalize(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isEntityAllowed(
  entityId: unknown,
  config: Pick<HomeAssistantConfig, "allowList">,
): boolean {
  const normalized = normalize(entityId);
  if (normalized === null) {
    return false;
  }
  // HA emits lowercase entity IDs; we match exactly post-trim. Mismatched
  // casing surfaces as a config error rather than getting silently coerced.
  return config.allowList.includes(normalized);
}

function buildDeniedResult(domain: string, service: string, detail: string): ServiceCheckResult {
  return {
    allowed: false,
    reason: { kind: "service-denied", domain, service, detail },
  };
}

function isWellFormedSegment(value: string): boolean {
  // Lowercased before this check; rejects empty strings, segments with dots
  // (which would let a caller smuggle past the deny-list comparison), and
  // anything outside the HA convention of [a-z][a-z0-9_]*.
  return SEGMENT_PATTERN.test(value);
}

export function checkServiceCall(
  args: { domain: unknown; service: unknown },
  config: Pick<HomeAssistantConfig, "denyServiceList">,
): ServiceCheckResult {
  const rawDomain = normalize(args.domain);
  const rawService = normalize(args.service);
  const domain = (rawDomain ?? "").toLowerCase();
  const service = (rawService ?? "").toLowerCase();

  if (rawDomain === null || rawDomain.length === 0) {
    return buildDeniedResult(domain, service, "empty or invalid domain");
  }
  if (rawService === null || rawService.length === 0) {
    return buildDeniedResult(domain, service, "empty or invalid service");
  }
  if (!isWellFormedSegment(domain) || !isWellFormedSegment(service)) {
    return buildDeniedResult(domain, service, "invalid <domain>.<service> format");
  }

  const key = `${domain}.${service}`;
  if (config.denyServiceList.includes(key)) {
    return buildDeniedResult(domain, service, `service "${key}" is in the deny-list`);
  }

  return { allowed: true, domain, service };
}

export function isServiceAllowed(
  domain: unknown,
  service: unknown,
  config: Pick<HomeAssistantConfig, "denyServiceList">,
): boolean {
  return checkServiceCall({ domain, service }, config).allowed;
}
