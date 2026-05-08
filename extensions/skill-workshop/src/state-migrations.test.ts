import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectSkillWorkshopLegacyStateMigrations } from "./state-migrations.js";
import { resolveSkillWorkshopStoreKey, SkillWorkshopStore } from "./store.js";
import type { SkillProposal } from "./types.js";

const tempDirs: string[] = [];
let previousStateDir: string | undefined;

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-workshop-migration-"));
  tempDirs.push(dir);
  return dir;
}

function createProposal(workspaceDir: string): SkillProposal {
  return {
    id: "proposal-1",
    createdAt: 10,
    updatedAt: 20,
    workspaceDir,
    skillName: "screenshot-workflow",
    title: "Screenshot Workflow",
    reason: "User correction",
    source: "tool",
    status: "pending",
    change: {
      kind: "create",
      description: "Screenshot workflow",
      body: "Verify dimensions.",
    },
  };
}

afterEach(async () => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  previousStateDir = undefined;
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("Skill Workshop legacy state migration", () => {
  it("imports legacy per-workspace JSON stores into SQLite plugin state", async () => {
    const stateDir = await makeTempDir();
    const workspaceDir = await makeTempDir();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const store = new SkillWorkshopStore({ workspaceDir });
    const legacyFilePath = path.join(
      stateDir,
      "skill-workshop",
      `${resolveSkillWorkshopStoreKey(workspaceDir)}.json`,
    );
    await fsp.mkdir(path.dirname(legacyFilePath), { recursive: true });
    await fsp.writeFile(
      legacyFilePath,
      `${JSON.stringify(
        {
          version: 1,
          proposals: [createProposal(workspaceDir)],
          review: {
            turnsSinceReview: 3,
            toolCallsSinceReview: 7,
            lastReviewAt: 30,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const plans = detectSkillWorkshopLegacyStateMigrations({ stateDir });
    expect(plans).toHaveLength(1);
    const plan = plans[0];
    if (plan?.kind !== "custom") {
      throw new Error("expected custom migration plan");
    }
    const result = await plan.apply({
      cfg: {},
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      stateDir,
      oauthDir: path.join(stateDir, "oauth"),
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes[0]).toContain("Imported 2 Skill Workshop row(s)");
    await expect(fsp.access(legacyFilePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await store.list("pending")).toEqual([expect.objectContaining({ id: "proposal-1" })]);
    const review = await store.recordReviewTurn(1);
    expect(review).toMatchObject({ turnsSinceReview: 4, toolCallsSinceReview: 8 });
    expect(fs.existsSync(path.dirname(legacyFilePath))).toBe(false);
  });
});
