// User-authored private skill -> runtime delivery (Phase A, S2).
//
// PROTOTYPE + config-filter reconciliation. The delivery mechanism
// (overlay/multitenant/sync-user-skills.sh) materializes each web-authored
// user skill as `~/.claude/skills/<name>/SKILL.md` — the same directory the
// runtime skill loader walks. These tests prove, against the REAL loader
// (loadWorkspaceSkillEntries) + the REAL prompt builder
// (buildWorkspaceSkillsPrompt), that:
//
//   1. a materialized user skill is loaded and shows up in the available-skills
//      prompt the agent sees — i.e. `please use /stub` is now discoverable
//      (the static, directory-based loader needs nothing more than the file on
//      disk; the spec's "prototype the delivery end-to-end" requirement).
//   2. config-filter reconciliation: with NO `agents.defaults.skills` allowlist
//      (the entrypoint-seeded byok config), the effective filter is undefined ==
//      allow-all and the user skill survives; an allowlist that OMITS the user
//      skill drops it (the failure mode S2 must guard against); an allowlist
//      that INCLUDES it keeps it.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type OpenClawConfig from "../../config/types.js";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../skills/home-env.test-support.js";
import { buildWorkspaceSkillsPrompt, loadWorkspaceSkillEntries } from "./workspace.js";

let tempRoot = "";
let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;
let caseIndex = 0;

async function createWorkspace() {
  const dir = path.join(tempRoot, `ws-${++caseIndex}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function loaderOpts(workspaceDir: string, extra?: Record<string, unknown>) {
  return {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...extra,
  } as Parameters<typeof loadWorkspaceSkillEntries>[1];
}

// Mirror what sync-user-skills.sh writes: a SKILL.md under the workspace
// skills/ dir (the same place the official claude binary + the gateway's
// workspace loader read from).
async function materializeUserSkill(workspaceDir: string, name: string, description: string) {
  await writeSkill({
    dir: path.join(workspaceDir, "skills", name),
    name,
    description,
    body: `# ${name}\n\nWhen invoked, reply with the marker STUB_OK.\n`,
  });
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "user-skill-delivery-"));
  fakeHome = path.join(tempRoot, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterAll(async () => {
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("user-skill runtime delivery (prototype)", () => {
  it("loads a materialized user skill and exposes it to the agent prompt", async () => {
    const ws = await createWorkspace();
    await materializeUserSkill(ws, "stub", "A throwaway user skill for the prototype.");

    const entries = loadWorkspaceSkillEntries(ws, loaderOpts(ws));
    const names = entries.map((e) => e.skill.name);
    expect(names).toContain("stub");

    // The available-skills prompt the agent reads must mention the skill, so
    // `please use /stub` resolves to a real loaded skill rather than dead text.
    const prompt = buildWorkspaceSkillsPrompt(ws, loaderOpts(ws));
    expect(prompt).toContain("stub");
  });

  it("survives when NO agents.defaults.skills allowlist is set (allow-all)", async () => {
    const ws = await createWorkspace();
    await materializeUserSkill(ws, "mine", "User skill, no allowlist.");

    // The entrypoint-seeded byok openclaw.json sets agents.defaults.model but
    // NO agents.defaults.skills — i.e. the effective filter is undefined.
    const config = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    } as unknown as OpenClawConfig;

    const prompt = buildWorkspaceSkillsPrompt(ws, loaderOpts(ws, { config, agentId: "default" }));
    expect(prompt).toContain("mine");
  });

  it("is DROPPED when an allowlist omits it (the reconciliation failure mode)", async () => {
    const ws = await createWorkspace();
    await materializeUserSkill(ws, "mine", "User skill not in the allowlist.");

    const config = {
      agents: { defaults: { skills: ["some-other-skill"] } },
    } as unknown as OpenClawConfig;

    const prompt = buildWorkspaceSkillsPrompt(ws, loaderOpts(ws, { config, agentId: "default" }));
    // Documents the guard: any future allowlist MUST include user skill names.
    expect(prompt).not.toContain("mine");
  });

  it("survives when the allowlist explicitly includes it", async () => {
    const ws = await createWorkspace();
    await materializeUserSkill(ws, "mine", "User skill in the allowlist.");

    const config = {
      agents: { defaults: { skills: ["mine"] } },
    } as unknown as OpenClawConfig;

    const prompt = buildWorkspaceSkillsPrompt(ws, loaderOpts(ws, { config, agentId: "default" }));
    expect(prompt).toContain("mine");
  });
});
