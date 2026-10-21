import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillLibraryAuthoringCapability } from "../../skills/library/authoring.js";

let resolveStableCliSkillAuthoring: typeof import("./stable-skill-authoring.js").resolveStableCliSkillAuthoring;

const human = (
  defaultTarget: "workspace" | "personal",
  multipleProfiles = true,
): SkillLibraryAuthoringCapability => ({
  target: "personal",
  defaultTarget,
  multipleProfiles,
  bind: () => {},
  invoke: async () => {
    throw new Error("live grant must not be reached from an internal turn");
  },
});

beforeEach(async () => {
  vi.resetModules();
  ({ resolveStableCliSkillAuthoring } = await import("./stable-skill-authoring.js"));
});

describe("resolveStableCliSkillAuthoring", () => {
  it("passes through sessions that never had a human authoring grant", () => {
    expect(resolveStableCliSkillAuthoring("agent:main:main", undefined)).toBeUndefined();
    expect(resolveStableCliSkillAuthoring(undefined, undefined)).toBeUndefined();
  });

  it("follows the latest human shape and keeps sessions separate", () => {
    resolveStableCliSkillAuthoring("agent:main:a", human("workspace", false));
    resolveStableCliSkillAuthoring("agent:main:a", human("personal", true));
    expect(resolveStableCliSkillAuthoring("agent:main:a", undefined)).toMatchObject({
      defaultTarget: "personal",
      multipleProfiles: true,
    });
    expect(resolveStableCliSkillAuthoring("agent:main:b", undefined)).toBeUndefined();
  });
});
