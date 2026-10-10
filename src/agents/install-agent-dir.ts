import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import type { OpenClawConfig } from "../config/types.js";
import { isMissingPathError } from "../infra/errno.js";
import {
  hasCompletedLegacyAgentDirMigration,
  resolveLegacyStandaloneAgentDir,
} from "../infra/state-migrations.agent-dir-receipt.js";
import { isUpdateRehearsalReadOnlyPath } from "../infra/update-rehearsal-paths.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../routing/session-key.js";
import { inspectOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-lifecycle.js";
import {
  listAgentIds,
  resolveEffectiveAgentDir,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyDataOwnerAgentId,
} from "./agent-scope-config.js";

type InstallAgentDirectory = {
  dir: string;
  readonly owner: string | undefined;
  migrationState: "legacy" | "current" | "explicit";
};

// Shipped 2026.9.x SDK directories retain their recorded database owner until Doctor migrates them.
// Explicit directory lookup precedes config inspection; the configured migration target is not ownership.
// Remove the legacy read after the migration ships in a release.
export function resolveInstallAgentDir(
  cfg:
    | OpenClawConfig
    | ((env: NodeJS.ProcessEnv) => { config: OpenClawConfig; env: NodeJS.ProcessEnv }),
  deps?: { env?: NodeJS.ProcessEnv; homedir?: () => string; agentDir?: string },
) {
  const baseEnv = cloneEnvWithPlatformSemantics(deps?.env ?? process.env);
  const homedir = deps?.homedir ?? os.homedir;
  let loaded: { config: OpenClawConfig; env: NodeJS.ProcessEnv } | undefined;
  const read = () =>
    (loaded ??= typeof cfg === "function" ? cfg(baseEnv) : { config: cfg, env: baseEnv });
  const overrideDir = () =>
    deps?.agentDir ??
    ((loaded?.env ?? baseEnv).OPENCLAW_AGENT_DIR?.replace(/^~(?=\/|$)/, () => homedir()) ||
      undefined);
  const agentId = () => {
    const { config } = read();
    const owner = tryResolveAmbientOwnerAgentId(config);
    return owner && listAgentIds(config).includes(owner) ? owner : undefined;
  };
  const targetDir = (selectedOwner?: string) => {
    const explicit = overrideDir();
    if (explicit !== undefined) {
      return explicit;
    }
    const { config, env } = read();
    const owner = selectedOwner ?? agentId();
    return (
      overrideDir() ||
      (owner ? resolveEffectiveAgentDir(config, owner, { env, homedir }) : undefined)
    );
  };
  const select = (
    dir: string,
    migrationState: InstallAgentDirectory["migrationState"],
  ): InstallAgentDirectory => {
    let recorded: { owner: string | undefined } | undefined;
    const readOwner = () => {
      const databasePath = path.join(dir, "openclaw-agent.sqlite");
      if (fs.existsSync(databasePath)) {
        const inspection = inspectOpenClawAgentDatabaseOwner(databasePath);
        if (inspection.status !== "owned") {
          throw new Error(
            `Cannot read the agent database owner at ${databasePath}. Run openclaw doctor --fix.`,
          );
        }
        return inspection.agentId;
      }
      return migrationState === "legacy" || deps?.agentDir !== undefined
        ? LEGACY_IMPLICIT_AGENT_ID
        : agentId();
    };
    return {
      dir,
      migrationState,
      get owner() {
        return (recorded ??= { owner: readOwner() }).owner;
      },
    };
  };
  let directory: InstallAgentDirectory | undefined;
  const resolveDirectory = (): InstallAgentDirectory | undefined => {
    const target = targetDir();
    const explicit = overrideDir();
    if (explicit !== undefined) {
      return select(explicit, "explicit");
    }
    const legacyDir = resolveLegacyStandaloneAgentDir(homedir);
    try {
      if (
        !isUpdateRehearsalReadOnlyPath(legacyDir, read().env) &&
        fs.readdirSync(legacyDir).length > 0 &&
        (!target || !hasCompletedLegacyAgentDirMigration(legacyDir, target))
      ) {
        return select(legacyDir, "legacy");
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    return target ? select(target, "current") : undefined;
  };
  return {
    get config() {
      return read().config;
    },
    get env() {
      return read().env;
    },
    get migrationTarget() {
      const { config } = read();
      // Retained provenance can target migration without selecting a runtime directory.
      const candidate =
        tryResolveAmbientOwnerAgentId(config) ?? tryResolveLegacyDataOwnerAgentId(config);
      const owner = candidate && listAgentIds(config).includes(candidate) ? candidate : undefined;
      const dir = targetDir(owner);
      return dir === undefined ? undefined : { dir, owner };
    },
    get optionalDirectory() {
      return (directory ??= resolveDirectory());
    },
    get directory() {
      const selected = (directory ??= resolveDirectory());
      if (!selected) {
        throw new Error(
          "Select an agent owner or set OPENCLAW_AGENT_DIR before resolving the install directory.",
        );
      }
      return selected;
    },
  };
}
