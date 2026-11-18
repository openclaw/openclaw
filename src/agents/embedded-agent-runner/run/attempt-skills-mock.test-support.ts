import { vi } from "vitest";

const skillMocks = vi.hoisted(() => ({
  prepareWorkspaceSkillsMock: vi.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []),
  resolveSkillsPromptForRunMock: vi.fn<(...args: unknown[]) => unknown>(() => ""),
}));

export function getSkillMocks() {
  return skillMocks;
}

vi.mock("../../../skills/runtime/env-overrides.js", () => ({
  applySkillEnvOverrides: () => () => {},
  applySkillEnvOverridesFromSnapshot: () => () => {},
}));

vi.mock("../../../skills/loading/workspace-skill-prompt.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/loading/workspace-skill-prompt.js")>()),
  resolveSkillsPrompt: (...args: unknown[]) => skillMocks.resolveSkillsPromptForRunMock(...args),
}));

vi.mock("../../../skills/loading/workspace-skill-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../skills/loading/workspace-skill-loader.js")>()),
  prepareWorkspaceSkills: (...args: unknown[]) => skillMocks.prepareWorkspaceSkillsMock(...args),
}));

export function resetSkillMocks() {
  skillMocks.prepareWorkspaceSkillsMock.mockReset().mockResolvedValue([]);
  skillMocks.resolveSkillsPromptForRunMock.mockReset().mockReturnValue("");
}
