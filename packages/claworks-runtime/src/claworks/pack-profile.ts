import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CW_EVENTS } from "../kernel/event-names.js";
import { persistInstalled, reloadClaworksPacks } from "./pack-runtime.js";
import { discoverPackSourceDir } from "./product-config-repair.js";
import type { ClaworksRuntime } from "./runtime-types.js";

/** Serialize concurrent profile switches so Pack reload stays atomic. */
let profileSwitchChain: Promise<unknown> = Promise.resolve();

/** CLI / Playbook profile 名 → claworks.packs.json profiles 键 */
export const PROFILE_PACK_ALIASES: Record<string, string> = {
  enterprise: "enterprise",
  industrial: "industrial-new",
  "daily-report": "daily-report",
  core: "enterprise-base-new",
  minimal: "enterprise-base-new",
  personal: "personal-enterprise-new",
  "industrial-robot": "industrial-new",
  "enterprise-robot": "enterprise-full-new",
  full: "enterprise-full-new",
};

const DEFAULT_PACK_IDS = [
  "base",
  "enterprise-foundation",
  "enterprise-general",
  "enterprise-commercial",
];

export function loadPacksConfig(packsDir: string | null): {
  default_profile?: string;
  profiles?: Record<string, { enabled_packs?: string[] }>;
} | null {
  if (!packsDir) {
    return null;
  }
  const configPath = join(packsDir, "claworks.packs.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as {
      default_profile?: string;
      profiles?: Record<string, { enabled_packs?: string[] }>;
    };
  } catch {
    return null;
  }
}

export function resolvePackProfileIds(
  profileName: string,
  opts?: { packsDir?: string | null; explicitPackIds?: string[] },
): string[] {
  const explicit = opts?.explicitPackIds?.filter(Boolean);
  if (explicit && explicit.length > 0) {
    return [...new Set(explicit)];
  }

  const packsDir = opts?.packsDir ?? discoverPackSourceDir();
  const raw = loadPacksConfig(packsDir);
  const key = PROFILE_PACK_ALIASES[profileName] ?? profileName;
  const fromProfile = raw?.profiles?.[key]?.enabled_packs;
  if (Array.isArray(fromProfile) && fromProfile.length > 0) {
    return [...fromProfile];
  }
  const fallbackKey = raw?.default_profile;
  const fallback = fallbackKey ? raw?.profiles?.[fallbackKey]?.enabled_packs : undefined;
  if (Array.isArray(fallback) && fallback.length > 0) {
    return [...fallback];
  }
  return [...DEFAULT_PACK_IDS];
}

export function parseProfilePackIds(payload: Record<string, unknown>): string[] | undefined {
  const raw = payload.packs;
  if (Array.isArray(raw)) {
    const ids = raw.map(String).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const ids = parsed.map(String).filter(Boolean);
        return ids.length > 0 ? ids : undefined;
      }
    } catch {
      const ids = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return ids.length > 0 ? ids : undefined;
    }
  }
  return undefined;
}

async function applyPackProfileOnce(
  runtime: ClaworksRuntime,
  opts: { profile: string; packIds?: string[]; source?: string },
): Promise<{ profile: string; pack_ids: string[] }> {
  const profile = opts.profile.trim() || "enterprise";
  const packsDir = discoverPackSourceDir();
  const packIds = resolvePackProfileIds(profile, {
    packsDir,
    explicitPackIds: opts.packIds,
  });

  await persistInstalled(packIds);
  runtime.config.packs = {
    ...runtime.config.packs,
    installed: packIds,
  };

  await reloadClaworksPacks(runtime);

  const source = opts.source ?? "pack.load_profile";
  await runtime.kernel.publish(CW_EVENTS.PACK_PROFILE_LOADED, source, {
    profile,
    pack_ids: packIds,
  });

  runtime.logger?.(
    `[claworks:packs] profile '${profile}' loaded (${packIds.length} packs: ${packIds.join(", ")})`,
  );

  return { profile, pack_ids: packIds };
}

export async function applyPackProfile(
  runtime: ClaworksRuntime,
  opts: { profile: string; packIds?: string[]; source?: string },
): Promise<{ profile: string; pack_ids: string[] }> {
  const run = profileSwitchChain.then(() => applyPackProfileOnce(runtime, opts));
  profileSwitchChain = run.catch(() => {});
  return run;
}
