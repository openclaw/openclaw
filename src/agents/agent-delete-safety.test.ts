import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { assertAgentSessionStoreDeletionSafe } from "./agent-delete-databases.js";
import { findOverlappingWorkspaceAgentIds, isSharedAuthStoreOwner } from "./agent-delete-safety.js";

describe("shared session store deletion safety", () => {
  it.each(["absent", "survivor-owned", "per-agent"])(
    "allows deletion with an %s session store",
    async (kind) => {
      await withStateDirEnv("openclaw-agent-delete-session-owner-", async ({ stateDir }) => {
        const sharedPath = path.join(stateDir, "shared.sqlite");
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
          session: {
            store:
              kind === "per-agent"
                ? path.join(stateDir, "agents", "{agentId}", "agent", "openclaw-agent.sqlite")
                : sharedPath,
          },
        };
        if (kind === "survivor-owned") {
          openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
        } else if (kind === "per-agent") {
          openOpenClawAgentDatabase({ agentId: "alpha" });
        }

        await expect(assertAgentSessionStoreDeletionSafe(cfg, "alpha")).resolves.toBeUndefined();
      });
    },
  );

  it.each([false, true])(
    "rechecks foreign ownership with an absent registry: %s",
    async (absentRegistry) => {
      await withStateDirEnv("openclaw-agent-delete-owner-commit-", async ({ stateDir }) => {
        const sharedPath = path.join(stateDir, "shared.sqlite");
        const cfg: OpenClawConfig = {
          agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
          session: { store: sharedPath },
        };
        openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
        const options = absentRegistry ? { path: path.join(stateDir, "absent-state.sqlite") } : {};
        await expect(
          assertAgentSessionStoreDeletionSafe(cfg, "alpha", options),
        ).resolves.toBeUndefined();

        const foreign = new DatabaseSync(sharedPath);
        try {
          foreign
            .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
            .run("alpha");
        } finally {
          foreign.close();
        }

        await expect(assertAgentSessionStoreDeletionSafe(cfg, "alpha", options)).rejects.toThrow(
          'Agent "alpha" owns the session database still used by agent "ops"',
        );
        if (options.path) {
          expect(fs.existsSync(options.path)).toBe(false);
        }
      });
    },
  );

  it("refuses a replaced session store after safety admission yields", async () => {
    await withStateDirEnv("openclaw-agent-delete-owner-replacement-", async ({ stateDir }) => {
      const sharedPath = path.join(stateDir, "shared.sqlite");
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { alpha: {}, ops: {} } },
        session: { store: sharedPath },
      };
      openOpenClawAgentDatabase({ agentId: "ops", path: sharedPath });
      await closeOpenClawAgentDatabasesAsync();
      const pending = assertAgentSessionStoreDeletionSafe(cfg, "alpha");
      const rejected = expect(pending).rejects.toThrow("changed during deletion planning");
      fs.renameSync(sharedPath, `${sharedPath}.captured`);
      fs.writeFileSync(sharedPath, "replacement fixture");
      await rejected;
    });
  });
});

describe("shared auth store deletion safety", () => {
  const sharedAuthDbPath = path.join(os.tmpdir(), "shared-auth", "openclaw-agent.sqlite");
  const otherAgentAuthDbPath = path.join(os.tmpdir(), "other-auth", "openclaw-agent.sqlite");

  it.each([
    {
      name: "blocks the legacy-main database owner",
      ownership: { location: "legacy-main" } as const,
      agentAuthDbPath: sharedAuthDbPath,
      expected: true,
    },
    {
      name: "allows a non-owner agent database",
      ownership: { location: "legacy-main" } as const,
      agentAuthDbPath: otherAgentAuthDbPath,
      expected: false,
    },
    {
      name: "follows state-db ownership instead of a legacy-main path match",
      ownership: { location: "state-db" } as const,
      agentAuthDbPath: sharedAuthDbPath,
      expected: false,
    },
  ])("$name", ({ ownership, agentAuthDbPath, expected }) => {
    expect(isSharedAuthStoreOwner({ ownership, agentAuthDbPath, sharedAuthDbPath })).toBe(expected);
  });
});

describe("shared workspace deletion safety", () => {
  it("detects another agent behind a dangling workspace symlink", () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-delete-alias-"));
    const workspaceDir = path.join(rootDir, "vanished-workspace");
    const workspaceAliasDir = path.join(rootDir, "workspace-alias");
    try {
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

      expect(findOverlappingWorkspaceAgentIds(config, "alpha", workspaceAliasDir)).toEqual([
        "beta",
      ]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
