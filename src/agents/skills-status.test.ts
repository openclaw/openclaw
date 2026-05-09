import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import type { SkillEntry } from "./skills/types.js";

type SkillStatus = ReturnType<typeof buildWorkspaceSkillStatus>["skills"][number];

describe("buildWorkspaceSkillStatus", () => {
  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "os-scoped",
        description: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toStrictEqual([]);
  });

  it("does not expose raw config values in config checks", () => {
    const secret = "discord-token-secret-abc"; // pragma: allowlist secret
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "discord",
        description: "test",
        filePath: "/tmp/discord/SKILL.md",
        baseDir: "/tmp/discord",
        source: "test",
      }),
      frontmatter: {},
      metadata: {
        requires: { config: ["channels.discord.token"] },
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [entry],
      config: {
        channels: {
          discord: {
            token: secret,
          },
        },
      },
    });

    expect(JSON.stringify(report)).not.toContain(secret);
    const discord = report.skills.find((skill) => skill.name === "discord");
    const check = discord?.configChecks.find((entry) => entry.path === "channels.discord.token");
    expect(check).toEqual({ path: "channels.discord.token", satisfied: true });
    expect(check && "value" in check).toBe(false);
  });

  it("warns for local skills without ClawHub origin or trusted root metadata", () => {
    withTempDir((workspaceDir) => {
      const entry = createTempSkillEntry(workspaceDir, "local-skill", "openclaw-workspace");

      const report = buildWorkspaceSkillStatus(workspaceDir, { entries: [entry] });
      const skill = report.skills[0];

      expect(skill?.trustSource).toBe("local");
      expect(skill?.untrustedLocalSource).toBe(true);
      expect(skill?.trustWarning).toContain("skills.load.trustedDirs");
    });
  });

  it("trusts local skills under configured trusted directories", () => {
    withTempDir((workspaceDir) => {
      const trustedRoot = path.join(workspaceDir, "reviewed-skills");
      const entry = createTempSkillEntry(trustedRoot, "reviewed-skill", "openclaw-extra");

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        entries: [entry],
        config: {
          skills: {
            load: {
              trustedDirs: [trustedRoot],
            },
          },
        },
      });

      const skill = report.skills[0];
      expect(skill?.trustSource).toBe("trusted-dir");
      expect(skill?.untrustedLocalSource).toBe(false);
      expect(skill?.trustWarning).toBeUndefined();
    });
  });

  it("trusts skills with valid ClawHub origin metadata", () => {
    withTempDir((workspaceDir) => {
      const entry = createTempSkillEntry(workspaceDir, "clawhub-skill", "openclaw-workspace");
      fs.mkdirSync(path.join(entry.skill.baseDir, ".clawhub"), { recursive: true });
      fs.writeFileSync(
        path.join(entry.skill.baseDir, ".clawhub", "origin.json"),
        JSON.stringify(
          {
            version: 1,
            registry: "https://clawhub.ai",
            slug: "clawhub-skill",
            installedVersion: "1.0.0",
            installedAt: Date.now(),
          },
          null,
          2,
        ),
      );

      const report = buildWorkspaceSkillStatus(workspaceDir, { entries: [entry] });
      const skill = report.skills[0];

      expect(skill?.trustSource).toBe("clawhub");
      expect(skill?.untrustedLocalSource).toBe(false);
      expect(skill?.trustWarning).toBeUndefined();
    });
  });

  it("reports prompt and command visibility separately from eligibility", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "background-only",
        description: "test",
        filePath: "/tmp/background-only/SKILL.md",
        baseDir: "/tmp/background-only",
        source: "test",
      }),
      frontmatter: {},
      invocation: {
        userInvocable: false,
        disableModelInvocation: true,
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills[0];
    expect(skill?.eligible).toBe(true);
    expect(skill?.modelVisible).toBe(false);
    expect(skill?.userInvocable).toBe(false);
    expect(skill?.commandVisible).toBe(false);
  });

  it("uses default-visible exposure semantics when older entries omit exposure fields", () => {
    const entry: SkillEntry = {
      skill: createFixtureSkill({
        name: "legacy-exposure",
        description: "test",
        filePath: "/tmp/legacy-exposure/SKILL.md",
        baseDir: "/tmp/legacy-exposure",
        source: "test",
      }),
      frontmatter: {},
      exposure: {
        includeInRuntimeRegistry: true,
      } as SkillEntry["exposure"],
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills[0];
    expect(skill?.eligible).toBe(true);
    expect(skill?.modelVisible).toBe(true);
    expect(skill?.userInvocable).toBe(true);
    expect(skill?.commandVisible).toBe(true);
  });

  it("reports skills blocked by an agent skill filter", () => {
    const alpha: SkillEntry = {
      skill: createFixtureSkill({
        name: "alpha",
        description: "test",
        filePath: "/tmp/alpha/SKILL.md",
        baseDir: "/tmp/alpha",
        source: "test",
      }),
      frontmatter: {},
    };
    const beta: SkillEntry = {
      skill: createFixtureSkill({
        name: "beta",
        description: "test",
        filePath: "/tmp/beta/SKILL.md",
        baseDir: "/tmp/beta",
        source: "test",
      }),
      frontmatter: {},
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [alpha, beta],
      agentId: "specialist",
      config: {
        agents: {
          list: [{ id: "specialist", skills: ["alpha"] }],
        },
      },
    });

    expect(report.agentId).toBe("specialist");
    expect(report.agentSkillFilter).toEqual(["alpha"]);
    expect(report.skills.find((skill) => skill.name === "alpha")?.blockedByAgentFilter).toBe(false);
    const byName = skillStatusByName(report.skills);
    expect(requireSkillStatus(byName, "alpha").modelVisible).toBe(true);
    expect(requireSkillStatus(byName, "beta").blockedByAgentFilter).toBe(true);
    expect(report.skills.find((skill) => skill.name === "beta")?.modelVisible).toBe(false);
  });

  it("classifies a mixed broken skill pack without flattening visibility reasons", () => {
    const missingBin = "openclaw-test-definitely-missing-skill-bin";
    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      agentId: "specialist",
      config: {
        agents: {
          list: [
            {
              id: "specialist",
              skills: [
                "ready",
                "needs-bin",
                "needs-env",
                "prompt-hidden",
                "slash-hidden",
                "disabled",
                "bundled-blocked",
              ],
            },
          ],
        },
        skills: {
          allowBundled: ["some-other-bundled-skill"],
          entries: {
            disabled: { enabled: false },
          },
          install: {
            nodeManager: "pnpm",
          },
        },
      },
      entries: [
        createEntry("ready"),
        createEntry("needs-bin", {
          metadata: {
            requires: { bins: [missingBin] },
            install: [
              {
                kind: "node",
                package: "@openclaw/missing-skill-bin",
                bins: [missingBin],
              },
            ],
          },
        }),
        createEntry("needs-env", {
          metadata: {
            primaryEnv: "OPENCLAW_TEST_MISSING_SKILL_KEY",
            requires: { env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"] },
          },
        }),
        createEntry("prompt-hidden", {
          invocation: {
            userInvocable: true,
            disableModelInvocation: true,
          },
        }),
        createEntry("slash-hidden", {
          invocation: {
            userInvocable: false,
            disableModelInvocation: false,
          },
        }),
        createEntry("agent-filtered"),
        createEntry("disabled"),
        createEntry("bundled-blocked", { source: "openclaw-bundled" }),
      ],
    });

    const byName = skillStatusByName(report.skills);
    expect(report.agentSkillFilter).toEqual([
      "ready",
      "needs-bin",
      "needs-env",
      "prompt-hidden",
      "slash-hidden",
      "disabled",
      "bundled-blocked",
    ]);
    expectStatusFlags(requireSkillStatus(byName, "ready"), {
      eligible: true,
      modelVisible: true,
      commandVisible: true,
    });
    const needsBin = requireSkillStatus(byName, "needs-bin");
    expectStatusFlags(needsBin, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(needsBin.missing).toStrictEqual({
      anyBins: [],
      bins: [missingBin],
      config: [],
      env: [],
      os: [],
    });
    expect(needsBin.install).toStrictEqual([
      {
        kind: "node",
        id: "node-0",
        label: "Install @openclaw/missing-skill-bin (pnpm)",
        bins: [missingBin],
      },
    ]);
    const needsEnv = requireSkillStatus(byName, "needs-env");
    expect(needsEnv.eligible).toBe(false);
    expect(needsEnv.primaryEnv).toBe("OPENCLAW_TEST_MISSING_SKILL_KEY");
    expect(needsEnv.missing).toStrictEqual({
      anyBins: [],
      bins: [],
      config: [],
      env: ["OPENCLAW_TEST_MISSING_SKILL_KEY"],
      os: [],
    });
    expectStatusFlags(requireSkillStatus(byName, "prompt-hidden"), {
      eligible: true,
      modelVisible: false,
      commandVisible: true,
    });
    const slashHidden = requireSkillStatus(byName, "slash-hidden");
    expectStatusFlags(slashHidden, {
      eligible: true,
      modelVisible: true,
      commandVisible: false,
    });
    expect(slashHidden.userInvocable).toBe(false);
    const agentFiltered = requireSkillStatus(byName, "agent-filtered");
    expectStatusFlags(agentFiltered, {
      eligible: true,
      modelVisible: false,
      commandVisible: false,
    });
    expect(agentFiltered.blockedByAgentFilter).toBe(true);
    const disabled = requireSkillStatus(byName, "disabled");
    expectStatusFlags(disabled, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(disabled.disabled).toBe(true);
    const bundledBlocked = requireSkillStatus(byName, "bundled-blocked");
    expectStatusFlags(bundledBlocked, {
      eligible: false,
      modelVisible: false,
      commandVisible: false,
    });
    expect(bundledBlocked.blockedByAllowlist).toBe(true);
  });
});

function skillStatusByName(skills: readonly SkillStatus[]): Map<string, SkillStatus> {
  return new Map(skills.map((skill) => [skill.name, skill]));
}

function requireSkillStatus(byName: ReadonlyMap<string, SkillStatus>, name: string): SkillStatus {
  const status = byName.get(name);
  if (!status) {
    throw new Error(`expected skill status ${name}`);
  }
  return status;
}

function expectStatusFlags(
  status: SkillStatus,
  expected: {
    eligible: boolean;
    modelVisible: boolean;
    commandVisible: boolean;
  },
): void {
  expect(status.eligible).toBe(expected.eligible);
  expect(status.modelVisible).toBe(expected.modelVisible);
  expect(status.commandVisible).toBe(expected.commandVisible);
}

function createEntry(
  name: string,
  params: {
    description?: string;
    source?: string;
    metadata?: SkillEntry["metadata"];
    invocation?: SkillEntry["invocation"];
  } = {},
): SkillEntry {
  const baseDir = `/tmp/${name}`;
  return {
    skill: createFixtureSkill({
      name,
      description: params.description ?? `${name} skill`,
      filePath: `${baseDir}/SKILL.md`,
      baseDir,
      source: params.source ?? "test",
    }),
    frontmatter: {},
    metadata: params.metadata,
    invocation: params.invocation,
  };
}

function createTempSkillEntry(rootDir: string, name: string, source: string): SkillEntry {
  const baseDir = path.join(rootDir, name);
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  fs.writeFileSync(filePath, `---\ndescription: ${name}\n---\n# ${name}\n`);
  return {
    skill: createFixtureSkill({
      name,
      description: `${name} skill`,
      filePath,
      baseDir,
      source,
    }),
    frontmatter: {},
  };
}

function withTempDir(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-skills-status-"));
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createFixtureSkill(params: {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: string;
}): SkillEntry["skill"] {
  return createCanonicalFixtureSkill(params);
}
