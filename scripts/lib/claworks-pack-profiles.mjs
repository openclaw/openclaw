/**
 * Resolve pack install lists from claworks-packs/claworks.packs.json profiles.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Legacy CLAWORKS_INIT_PROFILE aliases → profiles key in claworks.packs.json */
const PROFILE_ALIASES = {
  enterprise: "enterprise",
  /** @deprecated use enterprise or enterprise-base-new */
  core: "enterprise-base-new",
  /** @deprecated → enterprise-base-new */
  minimal: "enterprise-base-new",
  /** @deprecated → personal-enterprise-new */
  personal: "personal-enterprise-new",
  industrial: "industrial-new",
  /** @deprecated → industrial-new */
  "industrial-robot": "industrial-new",
  /** daily-report 飞书日报分析 */
  "daily-report": "daily-report",
  /** @deprecated → enterprise-full-new */
  "enterprise-robot": "enterprise-full-new",
  /** @deprecated → enterprise-full-new */
  full: "enterprise-full-new",
};

export function loadPacksConfig(packsDir) {
  const configPath = join(packsDir, "claworks.packs.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

export function resolvePackProfile(packsDir, profileName = "enterprise") {
  const raw = loadPacksConfig(packsDir);
  const key = PROFILE_ALIASES[profileName] ?? profileName;
  const fromProfile = raw?.profiles?.[key]?.enabled_packs;
  if (Array.isArray(fromProfile) && fromProfile.length > 0) {
    return [...fromProfile];
  }
  if (raw?.default_profile && raw.profiles?.[raw.default_profile]?.enabled_packs) {
    return [...raw.profiles[raw.default_profile].enabled_packs];
  }
  return ["base", "enterprise-foundation", "enterprise-general", "enterprise-commercial"];
}
