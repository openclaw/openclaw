import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import {
  hasBinaryMock,
  runCommandWithTimeoutMock,
  scanDirectoryWithSummaryMock,
} from "./skills-install.test-mocks.js";

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../security/skill-scanner.js", async () => ({
  ...(await vi.importActual<typeof import("../security/skill-scanner.js")>(
    "../security/skill-scanner.js",
  )),
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

vi.mock("../shared/config-eval.js", async () => {
  const actual = await vi.importActual<typeof import("../shared/config-eval.js")>(
    "../shared/config-eval.js",
  );
  return {
    ...actual,
    hasBinary: (bin: string) => hasBinaryMock(bin),
  };
});

vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: () => undefined,
}));

let installSkill: typeof import("./skills-install.js").installSkill;
let buildWorkspaceSkillStatus: typeof import("./skills-status.js").buildWorkspaceSkillStatus;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill } = await import("./skills-install.js"));
  ({ buildWorkspaceSkillStatus } = await import("./skills-status.js"));
}

async function writeSkillWithInstallers(
  workspaceDir: string,
  name: string,
  installSpecs: Array<Record<string, string>>,
): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ openclaw: { install: installSpecs } })}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

async function writeSkillWithInstaller(
  workspaceDir: string,
  name: string,
  kind: string,
  extra: Record<string, string>,
): Promise<string> {
  return writeSkillWithInstallers(workspaceDir, name, [{ id: "deps", kind, ...extra }]);
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
    await writeSkillWithInstaller(workspaceDir, "go-tool-single", "go", {
      module: "example.com/tool@latest",
    });
    await writeSkillWithInstallers(workspaceDir, "go-tool-multi", [
      { id: "brew", kind: "brew", formula: "go" },
      { id: "go", kind: "go", module: "example.com/tool@latest" },
    ]);
    await writeSkillWithInstaller(workspaceDir, "py-tool", "uv", {
      package: "example-package",
    });
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockClear();
    scanDirectoryWithSummaryMock.mockClear();
    hasBinaryMock.mockClear();
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, warn: 0, findings: [] });
  });

  afterAll(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("handles sudo probe failures for go install without apt fallback", async () => {
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
          expect(result.message).toContain("sudo");
          expect(result.message).toContain("https://go.dev/doc/install");
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

  it("status-selected go installer fails gracefully when apt fallback needs sudo", async () => {
    mockAvailableBinaries(["apt-get", "sudo"]);

    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "sudo: a password is required",
    });

    const status = buildWorkspaceSkillStatus(workspaceDir);
    const skill = status.skills.find((entry) => entry.name === "go-tool-multi");
    expect(skill?.install[0]?.id).toBe("go");

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool-multi",
      installId: skill?.install[0]?.id ?? "",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("sudo is not usable");
  });

  describe("brew formula apt fallback on Linux", () => {
    const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

    function setPlatform(platform: string) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }

    afterEach(() => {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    });

    it("falls back to apt-get when brew is missing on Linux (root user)", async () => {
      setPlatform("linux");
      mockAvailableBinaries(["apt-get"]);

      // Mock process.getuid to simulate root
      const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(0);

      // apt-get update (best effort) -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
      // apt-get install -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "installed openai-whisper",
        stderr: "",
      });

      await writeSkillWithInstaller(workspaceDir, "brew-tool-root", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-root",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["apt-get", "update", "-qq"],
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["apt-get", "install", "-y", "openai-whisper"],
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );

      getuidSpy.mockRestore();
    });

    it("falls back to sudo apt-get when brew is missing on Linux (non-root)", async () => {
      setPlatform("linux");
      mockAvailableBinaries(["apt-get", "sudo"]);

      // Mock process.getuid to simulate non-root
      const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1000);

      // sudo -n true check -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
      // sudo apt-get update -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
      // sudo apt-get install -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "installed openai-whisper",
        stderr: "",
      });

      await writeSkillWithInstaller(workspaceDir, "brew-tool-sudo", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-sudo",
        installId: "deps",
      });

      expect(result.ok).toBe(true);
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["sudo", "-n", "true"],
        expect.objectContaining({ timeoutMs: 5_000 }),
      );
      expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
        ["sudo", "apt-get", "install", "-y", "openai-whisper"],
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );

      getuidSpy.mockRestore();
    });

    it("returns failure when apt fallback fails on Linux", async () => {
      setPlatform("linux");
      mockAvailableBinaries(["apt-get"]);

      const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(0);

      // apt-get update -> success
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "",
      });
      // apt-get install -> failure
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 100,
        stdout: "",
        stderr: "E: Unable to locate package openai-whisper",
      });

      await writeSkillWithInstaller(workspaceDir, "brew-tool-apt-fail", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-apt-fail",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("automatic install");
      expect(result.message).toContain("apt failed");

      getuidSpy.mockRestore();
    });

    it("returns brew-not-installed error when apt-get is unavailable on Linux", async () => {
      setPlatform("linux");
      // No apt-get, no brew
      mockAvailableBinaries([]);

      await writeSkillWithInstaller(workspaceDir, "brew-tool-no-apt", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-no-apt",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("brew not installed");
    });

    it("returns sudo-required error when sudo needs password on Linux", async () => {
      setPlatform("linux");
      mockAvailableBinaries(["apt-get", "sudo"]);

      const getuidSpy = vi.spyOn(process, "getuid").mockReturnValue(1000);

      // sudo -n true -> fails (password required)
      runCommandWithTimeoutMock.mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "sudo: a password is required",
      });

      await writeSkillWithInstaller(workspaceDir, "brew-tool-sudo-fail", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-sudo-fail",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("sudo requires a password");

      getuidSpy.mockRestore();
    });

    it("does not attempt apt fallback on macOS", async () => {
      setPlatform("darwin");
      mockAvailableBinaries(["apt-get"]); // hypothetical, but should not be used

      await writeSkillWithInstaller(workspaceDir, "brew-tool-macos", "brew", {
        formula: "openai-whisper",
      });

      const result = await installSkill({
        workspaceDir,
        skillName: "brew-tool-macos",
        installId: "deps",
      });

      expect(result.ok).toBe(false);
      expect(result.message).toContain("brew not installed");
      expect(result.message).not.toContain("apt");
      // No commands should have been run
      expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
    });
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
