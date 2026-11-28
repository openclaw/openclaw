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
    const followup = resolveStableSkillAuthoring(
      "agent:main:a",
      expireSkillLibraryAuthoring(human("workspace"), "expired"),
    );
    expect(followup).toMatchObject({ defaultTarget: "workspace", expired: true });
    await expect(followup!.invoke({ action: "list" })).rejects.toThrow("expired");
    expect(() => followup!.assertWorkspaceCurrent?.({ sandboxed: false })).toThrow("expired");
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

  it("restores a refused listing without granting personal or sandboxed Workshop access", async () => {
    const refused: SkillLibraryAuthoringCapability = {
      ...human("workspace", false),
      turnRefusal: "This turn has no human requester, so the call was not run.",
      assertWorkspaceCurrent: () => {
        throw new Error("refused grant must not govern Workshop");
      },
    };
    const internal = resolveStableSkillAuthoring("agent:main:restored", refused)!;
    expect(internal).not.toBe(refused);
    expect(internal).toMatchObject({
      defaultTarget: "workspace",
      multipleProfiles: false,
      expired: true,
      turnRefusal: refused.turnRefusal,
    });
    await expect(internal.invoke({ action: "list" })).rejects.toThrow("fresh message");
    expect(() => internal.assertWorkspaceCurrent?.({ sandboxed: false })).not.toThrow();
    expect(() => internal.assertWorkspaceCurrent?.({ sandboxed: true })).toThrow(/sandboxed/);
    expect(() => internal.assertWorkspaceCurrent?.()).toThrow(/sandboxed/);
    const remembered = resolveStableSkillAuthoring("agent:main:restored", undefined)!;
    expect(() => remembered.assertWorkspaceCurrent?.({ sandboxed: false })).not.toThrow();
    expect(() => remembered.assertWorkspaceCurrent?.({ sandboxed: true })).toThrow(/sandboxed/);
  });

  it("keeps explicit follow-up expiry stronger than a restored turn refusal", async () => {
    const { expireSkillLibraryAuthoring } =
      await import("../auto-reply/reply/transcript-followup-run.js");
    resolveStableSkillAuthoring("agent:main:expired", human("workspace"));
    const followup = resolveStableSkillAuthoring("agent:main:expired", {
      ...expireSkillLibraryAuthoring(human("personal", false), "expired")!,
      turnRefusal: "This turn has no human requester.",
    })!;
    expect(followup).toMatchObject({
      defaultTarget: "workspace",
      multipleProfiles: true,
      expired: true,
    });
    await expect(followup.invoke({ action: "list" })).rejects.toThrow("expired");
    expect(() => followup.assertWorkspaceCurrent?.({ sandboxed: false })).toThrow("expired");
    expect(resolveStableSkillAuthoring("agent:main:expired", undefined)).toMatchObject({
      defaultTarget: "workspace",
      multipleProfiles: true,
    });
  });
});
