import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("../security/skill-scanner.js", () => ({
  scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
}));

let installSkill: typeof import("./skills-install.js").installSkill;
let skillsInstallTesting: typeof import("./skills-install.js").__testing;

async function loadSkillsInstallModulesForTest() {
  ({ installSkill, __testing: skillsInstallTesting } = await import("./skills-install.js"));
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
    await writeSkillWithInstaller(workspaceDir, "py-tool", "uv", {
      package: "example-package",
    });
    await loadSkillsInstallModulesForTest();
  });

  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    scanDirectoryWithSummaryMock.mockReset();
    hasBinaryMock.mockReset();
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, warn: 0, findings: [] });
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
