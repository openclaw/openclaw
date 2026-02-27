import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { resolveSandboxConfigForAgent } from "./config.js";

export const SEATBELT_DEMO_PROFILE_NAMES = [
  "demo-open",
  "demo-websearch",
  "demo-restricted",
] as const;

export type SeatbeltDemoProfileName = (typeof SEATBELT_DEMO_PROFILE_NAMES)[number];

export type EnsureSeatbeltDemoProfilesResult = {
  profileDir: string;
  sourceDir: string | null;
  copied: string[];
  existing: string[];
  missingSource: string[];
};

export function resolveBundledSeatbeltProfilesDir(): string | null {
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!packageRoot) {
    return null;
  }
  return path.join(packageRoot, "assets", "seatbelt-profiles");
}

export async function ensureSeatbeltDemoProfiles(params: {
  profileDir: string;
  sourceDir?: string;
  onWarn?: (message: string) => void;
}): Promise<EnsureSeatbeltDemoProfilesResult> {
  const sourceDir = params.sourceDir ?? resolveBundledSeatbeltProfilesDir();
  const copied: string[] = [];
  const existing: string[] = [];
  const missingSource: string[] = [];

  await fs.mkdir(params.profileDir, { recursive: true });

  if (!sourceDir) {
    for (const profile of SEATBELT_DEMO_PROFILE_NAMES) {
      missingSource.push(`${profile}.sb`);
    }
    params.onWarn?.(
      `seatbelt: bundled demo profile source directory was not found; skipping demo profile install into ${params.profileDir}`,
    );
    return {
      profileDir: params.profileDir,
      sourceDir: null,
      copied,
      existing,
      missingSource,
    };
  }

  for (const profile of SEATBELT_DEMO_PROFILE_NAMES) {
    const fileName = `${profile}.sb`;
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(params.profileDir, fileName);

    try {
      await fs.access(sourcePath);
    } catch {
      missingSource.push(fileName);
      params.onWarn?.(`seatbelt: bundled demo profile missing at ${sourcePath}`);
      continue;
    }

    try {
      await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
      copied.push(fileName);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        existing.push(fileName);
        continue;
      }
      throw error;
    }
  }

  return {
    profileDir: params.profileDir,
    sourceDir,
    copied,
    existing,
    missingSource,
  };
}

export async function ensureConfiguredSeatbeltDemoProfiles(params: {
  cfg: OpenClawConfig;
  sourceDir?: string;
  onWarn?: (message: string) => void;
}): Promise<{
  profileDirs: string[];
  totalCopied: number;
  results: EnsureSeatbeltDemoProfilesResult[];
}> {
  const profileDirs = collectConfiguredSeatbeltProfileDirs(params.cfg);
  const results: EnsureSeatbeltDemoProfilesResult[] = [];
  let totalCopied = 0;

  for (const profileDir of profileDirs) {
    const result = await ensureSeatbeltDemoProfiles({
      profileDir,
      sourceDir: params.sourceDir,
      onWarn: params.onWarn,
    });
    totalCopied += result.copied.length;
    results.push(result);
  }

  return {
    profileDirs,
    totalCopied,
    results,
  };
}

function collectConfiguredSeatbeltProfileDirs(cfg: OpenClawConfig): string[] {
  const agentIds = new Set<string>(["main"]);
  for (const entry of cfg.agents?.list ?? []) {
    const id = entry.id?.trim();
    if (id) {
      agentIds.add(id);
    }
  }

  const profileDirs = new Set<string>();
  for (const agentId of agentIds) {
    const sandbox = resolveSandboxConfigForAgent(cfg, agentId);
    if (sandbox.backend === "seatbelt") {
      profileDirs.add(sandbox.seatbelt.profileDir);
    }
  }

  return Array.from(profileDirs).toSorted();
}
