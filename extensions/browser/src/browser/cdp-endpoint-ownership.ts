/**
 * CDP endpoint ownership facts for Playwright's default-context overrides.
 *
 * The published fact says whether the browser behind an admitted CDP endpoint is
 * one OpenClaw launched or owns. Playwright's connect bootstrap overrides the
 * existing default browser context (download behavior, focus emulation, media
 * emulation) unless `noDefaults` is set; those overrides redirect native
 * downloads in a browser OpenClaw did not launch, so the CDP connection path
 * applies them only for endpoints whose browser OpenClaw launched.
 *
 * Prepared by profile admission only; never inferred from a CDP URL.
 *
 * Entries are keyed by normalized CDP endpoint and live for the process lifetime;
 * admission rewrites an endpoint's entry and nothing evicts it, because an owner
 * cannot change under a fixed config. Extension-relay profiles are exempt by
 * design (the user opted in and the relay supports `browser download`), so
 * "externally owned" means a plain CDP endpoint of a browser OpenClaw did not launch.
 */
import { stripCdpUrlCredentials } from "./cdp.helpers.js";
import { isOpenClawLaunchedBrowser } from "./config.js";
import type { ResolvedBrowserProfile } from "./profile.types.js";

type CdpEndpointOwnership = "managed" | "external";

/** Admitted endpoints; an endpoint absent here keeps Playwright's defaults. */
const ownershipByEndpoint = new Map<string, CdpEndpointOwnership>();

function normalizeCdpEndpointKey(cdpUrl: string): string {
  return stripCdpUrlCredentials(cdpUrl.trim()).replace(/\/+$/u, "");
}

/** Publish the ownership fact for one admitted profile's configured CDP endpoint. */
export function publishCdpEndpointOwnership(profile: ResolvedBrowserProfile): void {
  const key = normalizeCdpEndpointKey(profile.cdpUrl);
  if (!key) {
    return;
  }
  // Only a plain CDP endpoint of a browser OpenClaw did not launch drops
  // Playwright's default-context overrides. Extension-relay and existing-session
  // profiles keep their own connection paths and behavior.
  const external = profile.driver === "openclaw" && !isOpenClawLaunchedBrowser(profile);
  ownershipByEndpoint.set(key, external ? "external" : "managed");
}

/** True only for an admitted endpoint whose browser OpenClaw did not launch. */
export function isExternallyOwnedCdpEndpoint(cdpUrl: string): boolean {
  return ownershipByEndpoint.get(normalizeCdpEndpointKey(cdpUrl)) === "external";
}
