import { vi } from "vitest";

const skillMocks = vi.hoisted(() => ({
  resolveEmbeddedRunSkillEntriesMock: vi.fn<(...args: unknown[]) => unknown>(() => ({
    shouldLoadSkillEntries: false,
    skillEntries: [],
    loadSkillEntries: vi.fn(() => []),
  })),
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

vi.mock("../../../skills/runtime/embedded-run-entries.js", () => ({
  resolveEmbeddedRunSkillEntries: (...args: unknown[]) =>
    skillMocks.resolveEmbeddedRunSkillEntriesMock(...args),
}));

export function resetSkillMocks() {
  skillMocks.resolveEmbeddedRunSkillEntriesMock.mockReset().mockReturnValue({
    shouldLoadSkillEntries: false,
    skillEntries: [],
    loadSkillEntries: vi.fn(() => []),
  });
  skillMocks.resolveSkillsPromptForRunMock.mockReset().mockReturnValue("");
}
