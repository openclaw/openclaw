import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { hasBinaryMock, runCommandWithTimeoutMock } from "./skills-install.test-mocks.js";
import type { SkillEntry, SkillInstallSpec } from "./skills.js";

const skillsMocks = vi.hoisted(() => ({
  loadWorkspaceSkillEntries: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../plugins/install-security-scan.js", () => ({
  scanSkillInstallSource: vi.fn(async () => undefined),
}));

vi.mock("./skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: skillsMocks.loadWorkspaceSkillEntries,
  };
});

let installSkill: typeof import("./skills-install.js").installSkill;
let skillsInstallTesting: typeof import("./skills-install.js").__testing;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill, __testing: skillsInstallTesting } = await import("./skills-install.js"));
}

function makeSkillEntry(
  workspaceDir: string,
  name: string,
  installSpec: SkillInstallSpec,
): SkillEntry {
  const skillDir = path.join(workspaceDir, "skills", name);
  return {
    skill: {
      name,
      description: "test skill",
      filePath: path.join(skillDir, "SKILL.md"),
      baseDir: skillDir,
      source: "openclaw-workspace",
    } as SkillEntry["skill"],
    frontmatter: {},
    metadata: {
      install: [{ id: "deps", ...installSpec }],
    },
  };
}

function mockAvailableBinaries(binaries: string[]) {
  const available = new Set(binaries);
  hasBinaryMock.mockImplementation((bin: string) => available.has(bin));
}

function assertNoAptGetFallbackCalls() {
  const aptCalls = runCommandWithTimeoutMock.mock.calls.filter(
    (call) => Array.isArray(call[0]) && (call[0] as string[]).includes("apt-get"),
  );
  expect(aptCalls).toHaveLength(0);
}

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;

  beforeAll(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-test-"));
    skillsMocks.loadWorkspaceSkillEntries.mockReturnValue([
      makeSkillEntry(workspaceDir, "go-tool-single", {
        kind: "go",
        module: "example.com/tool@latest",
      }),
      makeSkillEntry(workspaceDir, "py-tool", {
        kind: "uv",
        package: "example-package",
      }),
      makeSkillEntry(workspaceDir, "brew-tool", {
        kind: "brew",
        formula: "jq",
      }),
    ]);
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    hasBinaryMock.mockReset();
    skillsInstallTesting.setDepsForTest({
      hasBinary: (bin: string) => hasBinaryMock(bin),
      resolveBrewExecutable: () => undefined,
    });
  });

  afterAll(async () => {
    skillsInstallTesting.setDepsForTest();
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("handles sudo probe failures for go install without apt fallback", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(1000);

    for (const testCase of [
      {
        label: "sudo returns password required",
        setup: () =>
          runCommandWithTimeoutMock.mockResolvedValueOnce({
            code: 1,
            stdout: "",
            stderr: "sudo: a password is required",
          }),
        assert: (result: { message: string; stderr: string }) => {
          expect(result.message).toContain("sudo is not usable");
          expect(result.message).toContain("https://go.dev/doc/install");
          expect(result.stderr).toContain("sudo: a password is required");
        },
      },
      {
        label: "sudo probe throws executable-not-found",
        setup: () =>
          runCommandWithTimeoutMock.mockRejectedValueOnce(
            new Error('Executable not found in $PATH: "sudo"'),
          ),
        assert: (result: { message: string; stderr: string }) => {
          expect(result.message).toContain("sudo is not usable");
          expect(result.message).toContain("https://go.dev/doc/install");
          expect(result.stderr).toContain("Executable not found");
        },
      },
    ]) {
      runCommandWithTimeoutMock.mockClear();
      mockAvailableBinaries(["apt-get", "sudo"]);
      testCase.setup();

      const result = await installSkill({
        workspaceDir,
        skillName: "go-tool-single",
        installId: "deps",
      });

      expect(result.ok, testCase.label).toBe(false);
      testCase.assert(result);
      expect(runCommandWithTimeoutMock, testCase.label).toHaveBeenCalledWith(
        ["sudo", "-n", "true"],
        expect.objectContaining({ timeoutMs: 5_000 }),
      );
      assertNoAptGetFallbackCalls();
    }
  });

  it("uv not installed and no brew returns helpful error without curl auto-install", async () => {
    mockAvailableBinaries(["curl"]);

    const result = await installSkill({
      workspaceDir,
      skillName: "py-tool",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("https://docs.astral.sh/uv/getting-started/installation/");

    // Verify NO curl command was attempted (no auto-install)
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
  });

  describe("brew fallback to native package managers on Linux", () => {
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    });

    afterEach(() => {
      platformSpy.mockRestore();
    });

    it("falls back to apt-get when brew is missing and apt-get is available (root)", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(0);
      mockAvailableBinaries(["apt-get"]);
      // apt-get update (best effort)
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      // apt-get install -y jq
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "installed", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("apt-get");
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["apt-get", "install", "-y", "jq"],
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
    });

    it("falls back to apk when brew is missing and apk is available (root)", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(0);
      mockAvailableBinaries(["apk"]);
      // apk add --no-cache jq
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "installed", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("apk");
    });

    it("falls back to dnf when brew is missing and dnf is available (root)", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(0);
      mockAvailableBinaries(["dnf"]);
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "installed", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(result.message).toContain("dnf");
    });

    it("uses sudo for apt-get when not root", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(1000);
      mockAvailableBinaries(["apt-get", "sudo"]);
      // sudo -n true
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      // sudo apt-get update
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      // sudo apt-get install -y jq
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "installed", stderr: "" });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["sudo", "apt-get", "install", "-y", "jq"],
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
    });

    it("returns failure when native package manager install fails", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(0);
      mockAvailableBinaries(["apt-get"]);
      // apt-get update
      runCommandWithTimeoutMock.mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      // apt-get install fails
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "E: Unable to locate package jq",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("Failed to install");
      expect(result.message).toContain("apt-get");
    });

    it("falls through to brew-missing error when no native package manager is available", async () => {
      mockAvailableBinaries([]);

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("brew not installed");
    });

    it("returns failure when sudo is unavailable for non-root", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(1000);
      mockAvailableBinaries(["apt-get"]);

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("sudo is not installed");
    });

    it("returns failure when sudo requires a password for non-root", async () => {
      vi.spyOn(process, "getuid").mockReturnValue(1000);
      mockAvailableBinaries(["apt-get", "sudo"]);
      // sudo -n true fails
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "sudo: a password is required",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("sudo requires a password");
    });
  });

  it("preserves system uv/python env vars when running uv installs", async () => {
    mockAvailableBinaries(["uv"]);
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 0,
      stdout: "ok",
      stderr: "",
      signal: null,
      killed: false,
    });

    const envSnapshot = captureEnv([
      "UV_PYTHON",
      "UV_INDEX_URL",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "VIRTUAL_ENV",
    ]);
    try {
      process.env.UV_PYTHON = "/tmp/attacker-python";
      process.env.UV_INDEX_URL = "https://example.invalid/simple";
      process.env.PIP_INDEX_URL = "https://example.invalid/pip";
      process.env.PYTHONPATH = "/tmp/attacker-pythonpath";
      process.env.VIRTUAL_ENV = "/tmp/attacker-venv";

      const result = await installSkill({
        workspaceDir,
        skillName: "py-tool",
        installId: "deps",
        timeoutMs: 10_000,
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["uv", "tool", "install", "example-package"],
        expect.objectContaining({
          timeoutMs: 10_000,
        }),
      );
      const firstCall = runCommandWithTimeoutMock.mock.calls[0] as
        | [string[], { timeoutMs?: number; env?: Record<string, string | undefined> }]
        | undefined;
      const envArg = firstCall?.[1]?.env;
      expect(envArg).toBeUndefined();
    } finally {
      envSnapshot.restore();
    }
  });
});
