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

  it("keeps unsandboxed Workshop available when a workspace listing is only a turn refusal", () => {
    const refused: SkillLibraryAuthoringCapability = {
      ...human("workspace", false),
      turnRefusal: "This turn has no human requester, so the call was not run.",
      assertWorkspaceCurrent: () => {
        throw new Error("refused grant must not govern Workshop");
      },
    };
    const internal = resolveStableCliSkillAuthoring("agent:main:cli", refused);
    expect(internal).not.toBe(refused);
    expect(internal?.turnRefusal).toContain("no human requester");
    expect(() => internal?.assertWorkspaceCurrent?.({ sandboxed: false })).not.toThrow();
    expect(() => internal?.assertWorkspaceCurrent?.({ sandboxed: true })).toThrow(/sandboxed/);
    expect(() => internal?.assertWorkspaceCurrent?.()).toThrow(/sandboxed/);
    const remembered = resolveStableCliSkillAuthoring("agent:main:cli", undefined);
    expect(() => remembered?.assertWorkspaceCurrent?.({ sandboxed: false })).not.toThrow();
    expect(() => remembered?.assertWorkspaceCurrent?.({ sandboxed: true })).toThrow(/sandboxed/);
  });
});
