import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";

const tempRoots = new Set<string>();

export const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

export async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hermes-migration-"));
  tempRoots.add(root);
  return root;
}

export async function cleanupTempRoots() {
  for (const root of tempRoots) {
    await fs.rm(root, { force: true, recursive: true });
  }
  tempRoots.clear();
}

export async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

export function makeContext(params: {
  source: string;
  stateDir: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  includeSecrets?: boolean;
  overwrite?: boolean;
  model?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];
  reportDir?: string;
}): MigrationProviderContext {
  const config =
    params.config ??
    ({
      agents: {
        defaults: {
          workspace: params.workspaceDir,
          ...(params.model !== undefined ? { model: params.model } : {}),
        },
      },
    } as OpenClawConfig);
  return {
    config,
    stateDir: params.stateDir,
    source: params.source,
    includeSecrets: params.includeSecrets,
    overwrite: params.overwrite,
    reportDir: params.reportDir,
    logger,
  };
}
