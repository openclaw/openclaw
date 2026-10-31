import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";

let resolveStableSkillAuthoring: ReturnType<
  typeof import("./stable-skill-authoring.js").createStableSkillAuthoring
>;

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
  resolveStableSkillAuthoring = (
    await import("./stable-skill-authoring.js")
  ).createStableSkillAuthoring();
});

describe("createStableSkillAuthoring", () => {
  it("passes through sessions that never had a human authoring grant", () => {
    expect(resolveStableSkillAuthoring("agent:main:main", undefined)).toBeUndefined();
    expect(resolveStableSkillAuthoring(undefined, undefined)).toBeUndefined();
  });

  it("follows the latest human shape and keeps sessions separate", () => {
    resolveStableSkillAuthoring("agent:main:a", human("workspace", false));
    resolveStableSkillAuthoring("agent:main:a", human("personal", true));
    expect(resolveStableSkillAuthoring("agent:main:a", undefined)).toMatchObject({
      defaultTarget: "personal",
      multipleProfiles: true,
    });
    expect(resolveStableSkillAuthoring("agent:main:b", undefined)).toBeUndefined();
  });

  it("keeps the human shape when a follow-up passes an expired grant", async () => {
    const { expireSkillLibraryAuthoring } =
      await import("../auto-reply/reply/transcript-followup-run.js");
    resolveStableSkillAuthoring("agent:main:a", human("workspace"));
    resolveStableSkillAuthoring(
      "agent:main:a",
      expireSkillLibraryAuthoring(human("workspace"), "expired"),
    );
    expect(resolveStableSkillAuthoring("agent:main:a", undefined)).toMatchObject({
      defaultTarget: "workspace",
    });
  });

  it("keeps each runtime's shapes separate", async () => {
    const { createStableSkillAuthoring } = await import("./stable-skill-authoring.js");
    const other = createStableSkillAuthoring();
    resolveStableSkillAuthoring("agent:main:a", human("workspace"));
    expect(other("agent:main:a", undefined)).toBeUndefined();
  });
});
