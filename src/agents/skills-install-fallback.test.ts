import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSkill } from "./skills-install.js";

const runCommandWithTimeoutMock = vi.fn();
const scanDirectoryWithSummaryMock = vi.fn();
const hasBinaryMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../security/skill-scanner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/skill-scanner.js")>();
  return {
    ...actual,
    scanDirectoryWithSummary: (...args: unknown[]) => scanDirectoryWithSummaryMock(...args),
  };
});

vi.mock("../shared/config-eval.js", () => ({
  hasBinary: (...args: unknown[]) => hasBinaryMock(...args),
}));

vi.mock("../infra/brew.js", () => ({
  resolveBrewExecutable: () => undefined,
}));

async function writeSkillWithInstaller(
  workspaceDir: string,
  name: string,
  kind: string,
  extra: Record<string, string>,
): Promise<string> {
  const skillDir = path.join(workspaceDir, "skills", name);
  await fs.mkdir(skillDir, { recursive: true });
  const installSpec = { id: "deps", kind, ...extra };
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: test skill
metadata: ${JSON.stringify({ openclaw: { install: [installSpec] } })}
---

# ${name}
`,
    "utf-8",
  );
  await fs.writeFile(path.join(skillDir, "runner.js"), "export {};\n", "utf-8");
  return skillDir;
}

describe("skills-install fallback edge cases", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fallback-test-"));
    scanDirectoryWithSummaryMock.mockResolvedValue({ critical: 0, warn: 0, findings: [] });
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("apt-get available but sudo missing/unusable returns helpful error for go install", async () => {
    await writeSkillWithInstaller(workspaceDir, "go-tool", "go", {
      module: "example.com/tool@latest",
    });

    // go not available, brew not available, apt-get + sudo are available, sudo check fails
    hasBinaryMock.mockImplementation((bin: string) => {
      if (bin === "go") {
        return false;
      }
      if (bin === "brew") {
        return false;
      }
      if (bin === "apt-get" || bin === "sudo") {
        return true;
      }
      return false;
    });

    // sudo -n true fails (no passwordless sudo)
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "sudo: a password is required",
    });

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("sudo");
    expect(result.message).toContain("https://go.dev/doc/install");

    // Verify sudo -n true was called
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["sudo", "-n", "true"],
      expect.objectContaining({ timeoutMs: 5_000 }),
    );

    // Verify apt-get install was NOT called
    const aptCalls = runCommandWithTimeoutMock.mock.calls.filter(
      (call) => Array.isArray(call[0]) && (call[0] as string[]).includes("apt-get"),
    );
    expect(aptCalls).toHaveLength(0);
  });

  it("handles sudo probe spawn failures without throwing", async () => {
    await writeSkillWithInstaller(workspaceDir, "go-tool", "go", {
      module: "example.com/tool@latest",
    });

    // go not available, brew not available, apt-get + sudo appear available
    hasBinaryMock.mockImplementation((bin: string) => {
      if (bin === "go") {
        return false;
      }
      if (bin === "brew") {
        return false;
      }
      if (bin === "apt-get" || bin === "sudo") {
        return true;
      }
      return false;
    });

    runCommandWithTimeoutMock.mockRejectedValueOnce(
      new Error('Executable not found in $PATH: "sudo"'),
    );

    const result = await installSkill({
      workspaceDir,
      skillName: "go-tool",
      installId: "deps",
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("sudo is not usable");
    expect(result.stderr).toContain("Executable not found");

    // Verify apt-get install was NOT called
    const aptCalls = runCommandWithTimeoutMock.mock.calls.filter(
      (call) => Array.isArray(call[0]) && (call[0] as string[]).includes("apt-get"),
    );
    expect(aptCalls).toHaveLength(0);
  });

  it("uv not installed and no brew returns helpful error without curl auto-install", async () => {
    await writeSkillWithInstaller(workspaceDir, "py-tool", "uv", {
      package: "example-package",
    });

    // uv not available, brew not available, curl IS available
    hasBinaryMock.mockImplementation((bin: string) => {
      if (bin === "uv") {
        return false;
      }
      if (bin === "brew") {
        return false;
      }
      if (bin === "curl") {
        return true;
      }
      return false;
    });

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
});
