import type { CoreConfig } from "./types.js";

const DEFAULT_API_BASE = "https://api.ro.am";

/** Resolve the Roam API v1 base URL, honoring per-account and top-level overrides. */
export function resolveApiBase(cfg?: CoreConfig, accountApiBaseUrl?: string): string {
  const override = (accountApiBaseUrl ?? cfg?.channels?.roam?.apiBaseUrl)?.replace(/\/+$/, "");
  return override ? `${override}/v1` : `${DEFAULT_API_BASE}/v1`;
}
