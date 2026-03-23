import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchClawHubSkillDetailMock = vi.fn();
const downloadClawHubSkillArchiveMock = vi.fn();
const listClawHubSkillsMock = vi.fn();
const resolveClawHubBaseUrlMock = vi.fn(() => "https://clawhub.ai");
const searchClawHubSkillsMock = vi.fn();
const withExtractedArchiveRootMock = vi.fn();
const installPackageDirMock = vi.fn();
const fileExistsMock = vi.fn();

vi.mock("../infra/clawhub.js", () => ({
  fetchClawHubSkillDetail: fetchClawHubSkillDetailMock,
  downloadClawHubSkillArchive: downloadClawHubSkillArchiveMock,
  listClawHubSkills: listClawHubSkillsMock,
  resolveClawHubBaseUrl: resolveClawHubBaseUrlMock,
  searchClawHubSkills: searchClawHubSkillsMock,
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

const { installSkillFromClawHub, searchSkillsFromClawHub } = await import("./skills-clawhub.js");

describe("skills-clawhub", () => {
  beforeEach(() => {
    fetchClawHubSkillDetailMock.mockReset();
    downloadClawHubSkillArchiveMock.mockReset();
    listClawHubSkillsMock.mockReset();
    resolveClawHubBaseUrlMock.mockReset();
    searchClawHubSkillsMock.mockReset();
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
    searchClawHubSkillsMock.mockResolvedValue([]);
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

  describe("normalizeSlug rejects non-ASCII homograph slugs", () => {
    it("rejects Cyrillic homograph 'а' (U+0430) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "re\u0430ct",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Cyrillic homograph 'е' (U+0435) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "r\u0435act",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Cyrillic homograph 'о' (U+043E) in slug", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "t\u043Edo",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug with mixed Unicode and ASCII", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "cаlеndаr",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug with non-Latin scripts", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "技能",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects Unicode that case-folds to ASCII (Kelvin sign U+212A)", async () => {
      // "\u212A" (Kelvin sign) lowercases to "k" — must be caught before lowercasing
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "\u212Aalendar",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug starting with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "-calendar",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("rejects slug ending with a hyphen", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-",
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid skill slug"),
      });
    });

    it("accepts uppercase ASCII slugs (preserves original casing behavior)", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "React",
      });
      expect(result).toMatchObject({ ok: true });
    });

    it("accepts valid lowercase ASCII slugs", async () => {
      const result = await installSkillFromClawHub({
        workspaceDir: "/tmp/workspace",
        slug: "calendar-2",
      });
      expect(result).toMatchObject({ ok: true });
    });
  });

  it("uses search for browse-all skill discovery", async () => {
    searchClawHubSkillsMock.mockResolvedValueOnce([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);

    await expect(searchSkillsFromClawHub({ limit: 20 })).resolves.toEqual([
      {
        score: 1,
        slug: "calendar",
        displayName: "Calendar",
        summary: "Calendar skill",
        version: "1.2.3",
        updatedAt: 123,
      },
    ]);
    expect(searchClawHubSkillsMock).toHaveBeenCalledWith({
      query: "*",
      limit: 20,
      baseUrl: undefined,
    });
    expect(listClawHubSkillsMock).not.toHaveBeenCalled();
  });
});
