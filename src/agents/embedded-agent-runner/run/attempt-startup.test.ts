import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillSnapshot } from "../../../skills/types.js";
import { prepareEmbeddedSkills } from "../skill-runtime.js";

const mocks = vi.hoisted(() => ({
  applySkillEnvOverrides: vi.fn(),
  applySkillEnvOverridesFromSnapshot: vi.fn(),
  mapSandboxSkillEntriesForPrompt: vi.fn(),
  prepareInstalledSkillCatalog: vi.fn(),
  resolveEmbeddedRunSkillEntries: vi.fn(() => ({
    shouldLoadSkillEntries: true,
    skillEntries: [],
    loadSkillEntries: vi.fn(() => []),
  })),
}));

vi.mock("../../installed-skill-runtime.js", () => ({
  prepareInstalledSkillCatalog: mocks.prepareInstalledSkillCatalog,
}));

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: mocks.applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot: mocks.applySkillEnvOverridesFromSnapshot,
}));

// mock-isolation: inject skill entries without filesystem discovery while testing startup cleanup.
vi.mock("../../../skills/runtime/embedded-run-entries.js", () => ({
  resolveEmbeddedRunSkillEntries: mocks.resolveEmbeddedRunSkillEntries,
}));

vi.mock("../../../skills/loading/workspace-skill-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/loading/workspace-skill-prompt.js")>()),
  resolveSkillsPrompt: vi.fn(() => "skills prompt"),
}));

vi.mock("../sandbox-skills.js", () => ({
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
    mocks.prepareInstalledSkillCatalog.mockReset().mockReturnValue([]);
    mocks.applySkillEnvOverrides.mockReturnValue(() => {});
    mocks.applySkillEnvOverridesFromSnapshot.mockReturnValue(() => {});
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

  it.each([{ modelRun: true }, { promptMode: "none" as const }])(
    "does not discover skills or apply their environment for a detached tool-free raw run: %j",
    async (rawMode) => {
      const attempt = {
        ...rawMode,
        sessionPersistence: "detached" as const,
        disableTools: true,
        config: {},
      };
      const prepared = await prepareEmbeddedSkills({
        includeCodeModeSkills: true,
        attempt,
        effectiveWorkspace: "/tmp/workspace",
        sandbox: null,
        sessionAgentId: "main",
      });

      expect(prepared.skillsPrompt).toBe("");
      expect(prepared.skillsSnapshotForRun).toBeUndefined();
      expect(prepared.codeModeSkills).toEqual([]);
      expect(mocks.resolveEmbeddedRunSkillEntries).not.toHaveBeenCalled();
      expect(mocks.applySkillEnvOverrides).not.toHaveBeenCalled();
      expect(mocks.applySkillEnvOverridesFromSnapshot).not.toHaveBeenCalled();
      expect(mocks.prepareInstalledSkillCatalog).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "durable raw",
      sessionPersistence: "durable" as const,
      modelRun: true,
      disableTools: true,
    },
    {
      label: "detached ordinary",
      sessionPersistence: "detached" as const,
      modelRun: false,
      disableTools: true,
    },
    {
      label: "detached tool-capable raw",
      sessionPersistence: "detached" as const,
      modelRun: true,
      disableTools: false,
    },
  ])("preserves skill preparation for $label runs", async ({ label: _label, ...mode }) => {
    mocks.applySkillEnvOverridesFromSnapshot.mockReturnValue(() => {});
    mocks.prepareInstalledSkillCatalog.mockReturnValue([]);
    const prepared = await prepareEmbeddedSkills({
      includeCodeModeSkills: true,
      attempt: { ...mode, config: {}, skillsSnapshot: { prompt: "skills prompt", skills: [] } },
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
      sessionAgentId: "main",
    });
    prepared.restoreSkillEnv();

    expect(prepared.skillsPrompt).toBe("skills prompt");
    expect(mocks.resolveEmbeddedRunSkillEntries).toHaveBeenCalledOnce();
    expect(mocks.applySkillEnvOverridesFromSnapshot).toHaveBeenCalledOnce();
    expect(mocks.prepareInstalledSkillCatalog).toHaveBeenCalledOnce();
  });
});
