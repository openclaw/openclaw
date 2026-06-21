/**
 * Map a resolved profile driver to the public status driver name shown by the
 * browser CLI and status surfaces.
 *
 * The internal resolved "extension" driver is produced from a configured
 * driver: "extension-bridge" profile, so it is surfaced as "extension-bridge" to
 * match what the user configured rather than leaking the internal name.
 *
 * A LEGACY input driver: "extension" means the old Chrome-MCP attach and is
 * migrated to "existing-session" by the doctor (legacy-config-core-normalizers)
 * BEFORE the config is resolved, so a resolved "extension" only ever originates
 * from "extension-bridge" -- there is no collision with the legacy meaning.
 */
export function toPublicProfileDriver(
  driver: "openclaw" | "existing-session" | "extension",
): "openclaw" | "existing-session" | "extension-bridge" {
  return driver === "extension" ? "extension-bridge" : driver;
}
