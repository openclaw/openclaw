// Tlon chat identity helpers accept only authenticated direct-message peers.
import { normalizeShip } from "../targets.js";

export function extractAuthenticatedDmPartnerShip(whom: unknown): string {
  const raw =
    typeof whom === "string"
      ? whom
      : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string"
        ? whom.ship
        : "";
  const normalized = normalizeShip(raw);
  return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
}

export function extractClubId(whom: unknown): string {
  if (typeof whom !== "string") {
    return "";
  }
  const trimmed = whom.trim();
  return /^0v[0-9a-z]+(?:\.[0-9a-z]+)*$/i.test(trimmed) ? trimmed : "";
}
