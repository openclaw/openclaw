import { describe, expect, it, vi } from "vitest";
import { resolveSessionSkillsSnapshot } from "./session-snapshot.js";

describe("resolveSessionSkillsSnapshot", () => {
  it("refreshes when the observed snapshot version increases", () => {
    const buildSnapshot = vi.fn(() => ({
      prompt: "new skills",
      skills: [{ name: "new-skill" }],
      version: 12,
    }));

    const result = resolveSessionSkillsSnapshot({
      currentSnapshot: {
        prompt: "old skills",
        skills: [{ name: "old-skill" }],
        version: 4,
      },
      isNewSession: false,
      snapshotVersion: 12,
      buildSnapshot,
    });

    expect(buildSnapshot).toHaveBeenCalledOnce();
    expect(result).toEqual({
      skillsSnapshot: {
        prompt: "new skills",
        skills: [{ name: "new-skill" }],
        version: 12,
      },
      shouldPersist: true,
    });
  });

  it("refreshes stale snapshots on cold start when content changed but version stayed at zero", () => {
    const buildSnapshot = vi.fn(() => ({
      prompt: "new skills",
      skills: [{ name: "new-skill" }],
      version: 0,
    }));

    const result = resolveSessionSkillsSnapshot({
      currentSnapshot: {
        prompt: "old skills",
        skills: [{ name: "old-skill" }],
        version: 0,
      },
      isNewSession: false,
      snapshotVersion: 0,
      buildSnapshot,
    });

    expect(buildSnapshot).toHaveBeenCalledOnce();
    expect(result).toEqual({
      skillsSnapshot: {
        prompt: "new skills",
        skills: [{ name: "new-skill" }],
        version: 0,
      },
      shouldPersist: true,
    });
  });

  it("keeps existing snapshots on cold start when the rebuilt content matches", () => {
    const currentSnapshot = {
      prompt: "same skills",
      skills: [{ name: "same-skill" }],
      version: 7,
    };
    const buildSnapshot = vi.fn(() => ({
      prompt: "same skills",
      skills: [{ name: "same-skill" }],
      version: 0,
    }));

    const result = resolveSessionSkillsSnapshot({
      currentSnapshot,
      isNewSession: false,
      snapshotVersion: 0,
      buildSnapshot,
    });

    expect(buildSnapshot).toHaveBeenCalledOnce();
    expect(result).toEqual({
      skillsSnapshot: currentSnapshot,
      shouldPersist: false,
    });
  });
});
