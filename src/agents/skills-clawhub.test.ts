import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClawHubSkillDetailMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const fileExistsMock = vi.fn();

vi.mock("../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  listClawHubSkills: vi.fn(),
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: vi.fn(),
}));

vi.mock("../infra/install-flow.js", () => ({
  withExtractedArchiveRoot: withExtractedArchiveRootMock,
}));

vi.mock("../infra/install-package-dir.js", () => ({
  installPackageDir: installPackageDirMock,
}));

vi.mock("../infra/archive.js", () => ({
  fileExists: fileExistsMock,
}));

const { installSkillFromClawHub } = await import("./skills-clawhub.js");

describe("skills-clawhub", () => {
  beforeEach(() => {
    fetchClawHubSkillDetailMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    withExtractedArchiveRootMock.mockReset();
    installPackageDirMock.mockReset();
    fileExistsMock.mockReset();

    resolveClawHubBaseUrlMock.mockReturnValue("https://clawhub.ai");
    fileExistsMock.mockImplementation(async (input: string) => input.endsWith("SKILL.md"));
    fetchClawHubSkillDetailMock.mockResolvedValue({
      skill: {
        slug: "agentreceipt",
        displayName: "AgentReceipt",
        createdAt: 1,
        updatedAt: 2,
      },
      latestVersion: {
        version: "1.0.0",
        createdAt: 3,
      },
    });
    downloadClawHubSkillArchiveMock.mockResolvedValue({
      archivePath: "/tmp/agentreceipt.zip",
      integrity: "sha256-test",
    });
    withExtractedArchiveRootMock.mockImplementation(async (params) => {
      expect(params.rootMarkers).toEqual(["SKILL.md"]);
      return await params.onExtracted("/tmp/extracted-skill");
    });
    installPackageDirMock.mockResolvedValue({
      ok: true,
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
  });

  it("installs ClawHub skills from flat-root archives", async () => {
    const result = await installSkillFromClawHub({
      workspaceDir: "/tmp/workspace",
      slug: "agentreceipt",
    });

    expect(downloadClawHubSkillArchiveMock).toHaveBeenCalledWith({
      slug: "agentreceipt",
      version: "1.0.0",
      baseUrl: undefined,
    });
    expect(installPackageDirMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceDir: "/tmp/extracted-skill",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      slug: "agentreceipt",
      version: "1.0.0",
      targetDir: "/tmp/workspace/skills/agentreceipt",
    });
  });
});
