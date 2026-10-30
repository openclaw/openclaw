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
const snapshot = () => ({ prompt: "skills prompt", skills: [] });
const detached = { sessionPersistence: "detached", disableTools: true, config: {} } as const;

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
        skillsSnapshot: hasSnapshot ? snapshot() : undefined,
      }),
    ).rejects.toThrow("skill reader preparation failed");
    expect(restore).toHaveBeenCalledOnce();
  },
);

it.each([
  { operation: "settled-tool-finalization" },
  { ...detached, modelRun: true },
  { ...detached, promptMode: "none" },
] as const)("does not prepare skills or apply their environment for %j", async (attempt) => {
  expect(await prepare(attempt)).toMatchObject({
    skillsPrompt: "",
    skillsSnapshotForRun: undefined,
    codeModeSkills: [],
  });
  for (const mock of Object.values(mocks)) {
    expect(mock).not.toHaveBeenCalled();
  }
});

it.each([
  ["durable", true, true],
  ["detached", false, true],
  ["detached", true, false],
] as const)(
  "preserves skills (persistence=%s, raw=%s, disableTools=%s)",
  async (sessionPersistence, modelRun, disableTools) => {
    const prepared = await prepare({
      sessionPersistence,
      modelRun,
      disableTools,
      config: {},
      skillsSnapshot: snapshot(),
    });
    prepared.restoreSkillEnv();

    expect(prepared.skillsPrompt).toBe("skills prompt");
  },
);
