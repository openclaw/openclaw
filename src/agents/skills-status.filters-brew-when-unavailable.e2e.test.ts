import { describe, expect, it, vi } from "vitest";
import type { SkillEntry } from "./skills/types.js";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { hasBinary } from "./skills/config.js";

vi.mock("./skills/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./skills/config.js")>();
  return {
    ...original,
    hasBinary: vi.fn((bin: string) => {
      // Simulate an environment where brew is not installed.
      if (bin === "brew") {
        return false;
      }
      return original.hasBinary(bin);
    }),
  };
});

describe("buildWorkspaceSkillStatus – brew filtering", () => {
  it("filters out brew install options when brew is not available", () => {
    const entry: SkillEntry = {
      skill: {
        name: "brew-only-skill",
        description: "Needs brew",
        source: "test",
        filePath: "/tmp/brew-only",
        baseDir: "/tmp",
      },
      frontmatter: {},
      metadata: {
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fakebin",
            bins: ["fakebin"],
            label: "Install fakebin (brew)",
          },
        ],
      },
    };

    // Verify mock is active.
    expect(hasBinary("brew")).toBe(false);
    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills.find((s) => s.name === "brew-only-skill");
    expect(skill).toBeDefined();
    expect(skill?.install).toEqual([]);
  });

  it("prefers non-brew install option when brew is not available", () => {
    const entry: SkillEntry = {
      skill: {
        name: "multi-install-skill",
        description: "Has brew and node options",
        source: "test",
        filePath: "/tmp/multi-install",
        baseDir: "/tmp",
      },
      frontmatter: {},
      metadata: {
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fakebin",
            bins: ["fakebin"],
            label: "Install fakebin (brew)",
          },
          {
            id: "node",
            kind: "node",
            package: "fakebin",
            bins: ["fakebin"],
            label: "Install fakebin (npm)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    const skill = report.skills.find((s) => s.name === "multi-install-skill");
    expect(skill).toBeDefined();
    expect(skill?.install).toHaveLength(1);
    expect(skill?.install[0]?.kind).toBe("node");
  });
});
