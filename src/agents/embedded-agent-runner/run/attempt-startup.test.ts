import { beforeEach, expect, it, vi } from "vitest";
import { prepareEmbeddedSkills } from "../skill-runtime.js";

const prepare = (attempt: Parameters<typeof prepareEmbeddedSkills>[0]["attempt"]) =>
  prepareEmbeddedSkills({
    includeCodeModeSkills: true,
    attempt,
    effectiveWorkspace: "/tmp/workspace",
    sandbox: null,
    sessionAgentId: "main",
  });

const mocks = vi.hoisted(() => ({
  applySkillEnvOverrides: vi.fn(),
  applySkillEnvOverridesFromSnapshot: vi.fn(),
  mapSandboxSkillEntriesForPrompt: vi.fn(),
  prepareInstalledSkillCatalog: vi.fn(),
  prepareWorkspaceSkills: vi.fn(async () => []),
}));

vi.mock("../../installed-skill-runtime.js", () => ({
  prepareInstalledSkillCatalog: mocks.prepareInstalledSkillCatalog,
}));

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: mocks.applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot: mocks.applySkillEnvOverridesFromSnapshot,
}));

// mock-isolation: inject skill entries without filesystem discovery while testing startup cleanup.
vi.mock("../../../skills/loading/workspace-skill-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/loading/workspace-skill-loader.js")>()),
  prepareWorkspaceSkills: mocks.prepareWorkspaceSkills,
}));

vi.mock("../sandbox-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-skills.js")>()),
  mapSandboxSkillEntriesForPrompt: mocks.mapSandboxSkillEntriesForPrompt,
}));

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
      prepare({
        config: {},
        skillsSnapshot: hasSnapshot ? { prompt: "skills prompt", skills: [] } : undefined,
      }),
    ).rejects.toThrow("skill reader preparation failed");
    expect(restore).toHaveBeenCalledOnce();
    expect(mocks.applySkillEnvOverridesFromSnapshot).toHaveBeenCalledTimes(hasSnapshot ? 1 : 0);
    expect(mocks.applySkillEnvOverrides).toHaveBeenCalledTimes(hasSnapshot ? 0 : 1);
  },
);

it("does not load skills or apply their environment during settled finalization", async () => {
  const prepared = await prepare({ operation: "settled-tool-finalization" });

  expect(prepared).toMatchObject({ skillsPrompt: "", skillsSnapshotForRun: undefined });
  for (const mock of Object.values(mocks)) {
    expect(mock).not.toHaveBeenCalled();
  }
});

it.each([{ modelRun: true }, { promptMode: "none" as const }])(
  "does not discover skills or apply their environment for a detached tool-free raw run: %j",
  async (rawMode) => {
    const prepared = await prepare({
      ...rawMode,
      sessionPersistence: "detached",
      disableTools: true,
      config: {},
    });

    expect(prepared.skillsPrompt).toBe("");
    expect(prepared.skillsSnapshotForRun).toBeUndefined();
    expect(prepared.codeModeSkills).toEqual([]);
    expect(mocks.prepareWorkspaceSkills).not.toHaveBeenCalled();
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
  const prepared = await prepare({
    ...mode,
    config: {},
    skillsSnapshot: { prompt: "skills prompt", skills: [] },
  });
  prepared.restoreSkillEnv();

  expect(prepared.skillsPrompt).toBe("skills prompt");
  expect(mocks.prepareWorkspaceSkills).toHaveBeenCalledOnce();
  expect(mocks.applySkillEnvOverridesFromSnapshot).toHaveBeenCalledOnce();
  expect(mocks.prepareInstalledSkillCatalog).toHaveBeenCalledOnce();
});
