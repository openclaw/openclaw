import { createSyntheticSourceInfo } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

vi.mock("./skills.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skills.js")>();
  return {
    ...actual,
    loadWorkspaceSkillEntries: () => [
      {
        skill: {
          name: "managed-skill",
          description: "managed",
          filePath: "/tmp/managed-skill/SKILL.md",
          source: "openclaw-managed",
          baseDir: "/tmp/managed-skill",
          sourceInfo: createSyntheticSourceInfo("/tmp/managed-skill/SKILL.md", {
            source: "openclaw-managed",
            baseDir: "/tmp/managed-skill",
          }),
        },
        metadata: {
          install: [{ id: "deps", kind: "node", package: "example-package" }],
        },
      },
    ],
  };
});

const { installSkill } = await import("./skills-install.js");

describe("installSkill managed policy", () => {
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
      scannedFiles: 1,
      critical: 1,
      warn: 0,
      info: 0,
      findings: [],
    });
  });

  it("blocks managed installs on critical findings unless force is true", async () => {
    const blocked = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "managed-skill",
      installId: "deps",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("Managed install/update blocked");

    const allowed = await installSkill({
      workspaceDir: "/tmp/workspace",
      skillName: "managed-skill",
      installId: "deps",
      force: true,
    });
    expect(allowed.ok).toBe(true);
  });
});
