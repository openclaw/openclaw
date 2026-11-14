import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { assertAgentSessionStoreDeletionSafe } from "./agent-delete-databases.js";
import { findOverlappingWorkspaceAgentIds, isSharedAuthStoreOwner } from "./agent-delete-safety.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function sessionConfig(store: string): OpenClawConfig {
  return {
    agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
    session: { store },
  };
}

it.each(["absent", "survivor-owned", "per-agent"])(
  "allows deletion with an %s session store",
  (kind) =>
    withStateDirEnv("openclaw-agent-delete-session-owner-", async ({ stateDir }) => {
      const sharedPath = path.join(stateDir, "shared.sqlite");
      const cfg = sessionConfig(
        kind === "per-agent"
          ? path.join(stateDir, "agents", "{agentId}", "agent", "openclaw-agent.sqlite")
          : sharedPath,
      );
      if (kind === "survivor-owned") {
        openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
      } else if (kind === "per-agent") {
        openOpenClawAgentDatabase({ agentId: "alpha" });
      }

      await expect(assertAgentSessionStoreDeletionSafe(cfg, "alpha")).resolves.toBeUndefined();
    }),
);

it.each([false, true])("rechecks foreign ownership with an absent registry: %s", (absentRegistry) =>
  withStateDirEnv("openclaw-agent-delete-owner-commit-", async ({ stateDir }) => {
    const sharedPath = path.join(stateDir, "shared.sqlite");
    const cfg = sessionConfig(sharedPath);
    openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
    const options = absentRegistry ? { path: path.join(stateDir, "absent-state.sqlite") } : {};
    const admission = assertAgentSessionStoreDeletionSafe(cfg, "alpha", options);
    await expect(admission).resolves.toBeUndefined();

    {
      using foreign = new DatabaseSync(sharedPath);
      foreign.exec("UPDATE schema_meta SET agent_id = 'alpha' WHERE meta_key = 'primary'");
    }

    await expect(assertAgentSessionStoreDeletionSafe(cfg, "alpha", options)).rejects.toThrow(
      'Agent "alpha" owns the session database still used by agent "ops"',
    );
    if (options.path) {
      expect(fs.existsSync(options.path)).toBe(false);
    }
  }),
);

it("refuses a replaced session store after safety admission yields", () =>
  withStateDirEnv("openclaw-agent-delete-owner-replacement-", async ({ stateDir }) => {
    const sharedPath = path.join(stateDir, "shared.sqlite");
    const cfg = sessionConfig(sharedPath);
    openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
    await closeOpenClawAgentDatabasesAsync();
    const pending = assertAgentSessionStoreDeletionSafe(cfg, "alpha");
    const rejected = expect(pending).rejects.toThrow("changed during deletion planning");
    fs.renameSync(sharedPath, `${sharedPath}.captured`);
    fs.writeFileSync(sharedPath, "replacement fixture");
    await rejected;
  }));

const sharedAuthDbPath = path.join(os.tmpdir(), "shared-auth", "openclaw-agent.sqlite");
const otherAgentAuthDbPath = path.join(os.tmpdir(), "other-auth", "openclaw-agent.sqlite");

it.each([
  ["legacy-main", sharedAuthDbPath, true],
  ["legacy-main", otherAgentAuthDbPath, false],
  ["state-db", sharedAuthDbPath, false],
] as const)("ownership %s at %s blocks deletion: %s", (location, agentAuthDbPath, expected) => {
  expect(
    isSharedAuthStoreOwner({ ownership: { location }, agentAuthDbPath, sharedAuthDbPath }),
  ).toBe(expected);
});
it("detects another agent behind a dangling workspace symlink", () => {
  const rootDir = tempDirs.make("openclaw-agent-delete-alias-");
  const workspaceDir = path.join(rootDir, "vanished-workspace");
  const workspaceAliasDir = path.join(rootDir, "workspace-alias");
  fs.symlinkSync(
    workspaceDir,
    workspaceAliasDir,
    process.platform === "win32" ? "junction" : "dir",
  );
  const config: OpenClawConfig = {
    agents: {
      entries: {
        alpha: { workspace: workspaceAliasDir },
        beta: { workspace: workspaceDir },
      },
    },
  };

  expect(findOverlappingWorkspaceAgentIds(config, "alpha", workspaceAliasDir)).toEqual(["beta"]);
});
