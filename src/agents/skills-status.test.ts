import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillStatus } from "./skills-status.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
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

  it("applies skills policy when status is scoped to an agent", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-status-"));
    try {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "alpha"),
        name: "alpha",
        description: "Alpha",
      });
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "beta"),
        name: "beta",
        description: "Beta",
      });

      const report = buildWorkspaceSkillStatus(workspaceDir, {
        agentId: "ops",
        config: {
          agents: {
            list: [{ id: "ops" }],
          },
          skills: {
            policy: {
              globalEnabled: ["alpha"],
              agentOverrides: {
                ops: {},
              },
            },
          },
        },
      });

      expect(report.skills.map((entry) => entry.name).toSorted()).toEqual(["alpha"]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
