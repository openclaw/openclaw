import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import type { SkillEntry } from "./skills/types.js";

describe("buildWorkspaceSkillStatus", () => {
  it("does not surface install options for OS-scoped skills on unsupported platforms", () => {
    if (process.platform === "win32") {
      // Keep this simple; win32 platform naming is already explicitly handled elsewhere.
      return;
    }

    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";

    const entry: SkillEntry = {
      skill: {
        name: "os-scoped",
        description: "test",
        source: "test",
        filePath: "/tmp/os-scoped",
        baseDir: "/tmp",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {
        os: [mismatchedOs],
        requires: { bins: ["fakebin"] },
        install: [
          {
            id: "brew",
            kind: "brew",
            formula: "fake",
            bins: ["fakebin"],
            label: "Install fake (brew)",
          },
        ],
      },
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", { entries: [entry] });
    expect(report.skills).toHaveLength(1);
    expect(report.skills[0]?.install).toEqual([]);
  });

  it("marks skill as bundled only when source is openclaw-bundled, not by name", () => {
    // Regression test for #47139: workspace skills with same name as a bundled skill
    // were incorrectly displayed as "bundled" in the Control Panel.
    const workspaceSkillWithBundledName: SkillEntry = {
      skill: {
        name: "summarize", // same name as a bundled skill
        description: "summarize from workspace",
        source: "openclaw-workspace", // but sourced from workspace
        filePath: "/workspace/skills/summarize/SKILL.md",
        baseDir: "/workspace/skills/summarize",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {},
    };

    const bundledSkillWithSameName: SkillEntry = {
      skill: {
        name: "summarize",
        description: "summarize bundled",
        source: "openclaw-bundled",
        filePath: "/bundled/summarize/SKILL.md",
        baseDir: "/bundled/summarize",
        disableModelInvocation: false,
      },
      frontmatter: {},
      metadata: {},
    };

    const report = buildWorkspaceSkillStatus("/tmp/ws", {
      entries: [workspaceSkillWithBundledName, bundledSkillWithSameName],
    });

    expect(report.skills).toHaveLength(2);

    const workspaceResult = report.skills.find(
      (s) => s.skill.source === "openclaw-workspace",
    );
    const bundledResult = report.skills.find(
      (s) => s.skill.source === "openclaw-bundled",
    );

    expect(workspaceResult?.bundled).toBe(false);
    expect(bundledResult?.bundled).toBe(true);
  });
});

