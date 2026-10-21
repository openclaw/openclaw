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

vi.mock("../sandbox-skills.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-skills.js")>()),
  mapSandboxSkillEntriesForPrompt: mocks.mapSandboxSkillEntriesForPrompt,
}));

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
