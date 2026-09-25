import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSnapshot } from "../../../skills/types.js";
import { prepareEmbeddedSkills } from "../skill-runtime.js";

const mocks = vi.hoisted(() => ({
  applySkillEnvOverrides: vi.fn(),
  applySkillEnvOverridesFromSnapshot: vi.fn(),
  mapSandboxSkillEntriesForPrompt: vi.fn(),
  prepareInstalledSkillCatalog: vi.fn(),
}));

vi.mock("../../installed-skill-runtime.js", () => ({
  prepareInstalledSkillCatalog: mocks.prepareInstalledSkillCatalog,
}));

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: mocks.applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot: mocks.applySkillEnvOverridesFromSnapshot,
}));

vi.mock("../../../skills/runtime/embedded-run-entries.js", () => ({
  resolveEmbeddedRunSkillEntries: vi.fn(() => ({
    shouldLoadSkillEntries: true,
    skillEntries: [],
    loadSkillEntries: vi.fn(() => []),
  })),
}));

vi.mock("../../../skills/loading/workspace-skill-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/loading/workspace-skill-prompt.js")>()),
  resolveSkillsPrompt: vi.fn(() => "skills prompt"),
}));

vi.mock("../sandbox-skills.js", () => ({
  createSandboxPromptEntryLoader: vi.fn(
    ({ loadEntries }: { loadEntries: () => unknown[] }) => loadEntries,
  ),
  resolveSandboxSkillRuntimeInputs: vi.fn(
    ({ skillsSnapshot }: { skillsSnapshot?: SkillSnapshot }) => ({
      skillsEligibility: undefined,
      skillUsagePaths: [],
      skillsPromptWorkspaceDir: "/tmp/workspace",
      skillsSnapshot,
      skillsWorkspaceDir: "/tmp/workspace",
      workspaceOnly: false,
    }),
  ),
  mapSandboxSkillEntriesForPrompt: mocks.mapSandboxSkillEntriesForPrompt,
}));

describe("prepareEmbeddedSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])(
    "restores environment overrides after failure (snapshot=%s)",
    async (hasSnapshot) => {
      const restore = vi.fn();
      mocks.applySkillEnvOverrides.mockReturnValue(restore);
      mocks.applySkillEnvOverridesFromSnapshot.mockReturnValue(restore);
      mocks.prepareInstalledSkillCatalog.mockImplementation(() => {
        throw new Error("skill reader preparation failed");
      });

      await expect(
        prepareEmbeddedSkills({
          includeCodeModeSkills: true,
          attempt: {
            config: {},
            skillsSnapshot: hasSnapshot ? { prompt: "skills prompt", skills: [] } : undefined,
          },
          effectiveWorkspace: "/tmp/workspace",
          sandbox: null,
          sessionAgentId: "main",
        }),
      ).rejects.toThrow("skill reader preparation failed");
      expect(restore).toHaveBeenCalledOnce();
      expect(
        hasSnapshot ? mocks.applySkillEnvOverridesFromSnapshot : mocks.applySkillEnvOverrides,
      ).toHaveBeenCalledOnce();
      expect(
        hasSnapshot ? mocks.applySkillEnvOverrides : mocks.applySkillEnvOverridesFromSnapshot,
      ).not.toHaveBeenCalled();
    },
  );

  it("does not load skills or apply their environment during settled finalization", async () => {
    const prepared = await prepareEmbeddedSkills({
      includeCodeModeSkills: true,
      attempt: { operation: "settled-tool-finalization" },
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
      sessionAgentId: "main",
    });

    expect(prepared.skillsPrompt).toBe("");
    expect(prepared.skillsSnapshotForRun).toBeUndefined();
    expect(mocks.applySkillEnvOverrides).not.toHaveBeenCalled();
    expect(mocks.applySkillEnvOverridesFromSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareInstalledSkillCatalog).not.toHaveBeenCalled();
    expect(mocks.mapSandboxSkillEntriesForPrompt).not.toHaveBeenCalled();
  });
});
