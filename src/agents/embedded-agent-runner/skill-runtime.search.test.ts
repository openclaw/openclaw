import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { writeWorkspaceSkills } from "../../skills/test-support/e2e-test-helpers.js";
import { readCodeModeSkill, searchCodeModeSkills } from "../code-mode-skills.js";
import { createAgentToolsSandboxContext } from "../test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  setActiveDegradedSecretOwners([]);
  vi.unstubAllEnvs();
});

it.each([
  "live",
  "warm",
  "cold",
  "empty-display",
  "sandbox",
  "sandbox-empty",
  "sandbox-live",
  "default",
  "disabled",
  "warm-disabled",
] as const)(
  "discovers overflow through real runtime preparation (%s), retaining policy and secret gates",
  async (mode) => {
    const searchEnabled = !["default", "disabled", "warm-disabled"].includes(mode);
    const root = temps.make("skill-search-runtime-");
    const workspace = path.join(root, "workspace");
    const bundled = path.join(root, "bundled");
    await fs.mkdir(bundled);
    vi.stubEnv("HOME", root);
    vi.stubEnv("OPENCLAW_HOME", root);
    vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
    vi.stubEnv("OPENCLAW_SKILL_SEARCH_TEST_MISSING", undefined);
    await writeWorkspaceSkills(workspace, [
      { name: "alpha", description: "General reference" },
      {
        name: "release",
        description: "Verify release publishing checks",
        body: "# Release\n" + "Complete procedure. ".repeat(100) + "END",
        metadata: JSON.stringify({ openclaw: { skillKey: "release-key" } }),
      },
      {
        name: "manual",
        description: "Manual release procedure",
        frontmatterExtra: "disable-model-invocation: true",
      },
      { name: "disabled", description: "Disabled release procedure" },
      { name: "outside", description: "Outside the allowlist" },
      {
        name: "needs-env",
        description: "Unavailable release procedure",
        metadata: JSON.stringify({
          openclaw: { requires: { env: ["OPENCLAW_SKILL_SEARCH_TEST_MISSING"] } },
        }),
      },
    ]);
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { skills: ["alpha", "release", "manual", "disabled", "needs-env"] } },
      skills: {
        ...(mode === "default" ? {} : { experimental: { search: searchEnabled } }),
        load: { watch: false },
        entries: { disabled: { enabled: false } },
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: mode.includes("empty") ? 1 : 18000,
        },
      },
    };
    const snapshot =
      mode === "live" || mode === "sandbox-live"
        ? undefined
        : await buildSkillSnapshot(workspace, {
            config:
              mode === "warm-disabled"
                ? { ...config, skills: { ...config.skills, experimental: { search: true } } }
                : config,
            agentId: "main",
          });
    if (mode === "cold" && snapshot) {
      delete snapshot.resolvedSkills;
    }
    const prepare = () =>
      prepareEmbeddedSkills({
        attempt: { config, skillsSnapshot: snapshot },
        effectiveWorkspace: workspace,
        sandbox: mode.startsWith("sandbox")
          ? createAgentToolsSandboxContext({
              workspaceDir: workspace,
              skillsWorkspaceDir: workspace,
              workspaceAccess: "ro",
              fsBridge: createHostSandboxFsBridge(workspace),
            })
          : undefined,
        sessionAgentId: "main",
        includeCodeModeSkills: true,
        applySkillEnvironment: false,
      });
    const prepared = await prepare();
    expect(prepared.skillsPrompt).not.toContain("<name>release</name>");
    expect(prepared.codeModeSkills.map((skill) => skill.name)).toEqual(
      searchEnabled ? ["alpha", "release"] : ["alpha"],
    );
    if (!searchEnabled) {
      expect(searchCodeModeSkills(prepared.codeModeSkills, "publishing")).toEqual([]);
      return;
    }
    expect(
      searchCodeModeSkills(prepared.codeModeSkills, "publishing").map((skill) => skill.name),
    ).toEqual(["release"]);
    if (mode.startsWith("sandbox")) {
      expect(prepared.codeModeSkills[1]!.location).toBe("/workspace/skills/release/SKILL.md");
    }
    expect(await readCodeModeSkill(prepared.codeModeSkills[1]!)).toContain(
      "Complete procedure. END",
    );
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:release-key",
        state: "unavailable",
        paths: ["skills.entries.release-key.apiKey"],
        refKeys: ["env:default:UNAVAILABLE_SKILL_TEST"],
        reason: "fixture provider unavailable",
      },
    ]);
    const degraded = await prepare();
    expect(degraded.codeModeSkills.map((skill) => skill.name)).toEqual(["alpha"]);
  },
);
