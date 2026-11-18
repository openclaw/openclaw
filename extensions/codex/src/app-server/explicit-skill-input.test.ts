import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexExplicitSkillInputs } from "./explicit-skill-input.js";
import type { CodexSkillsListResponse } from "./protocol-control-plane.js";

describe("resolveCodexExplicitSkillInputs", () => {
  const cwd = path.resolve("repo");
  const skillPath = path.join(cwd, ".agents", "skills", "release", "SKILL.md");
  const selections = [{ name: "release", path: skillPath }];
  const resolve = (request: ReturnType<typeof vi.fn>, selected = selections) =>
    resolveCodexExplicitSkillInputs({ client: { request } as never, cwd, selections: selected });
  const skill = {
    name: "release",
    description: "Release workflow",
    path: skillPath,
    scope: "repo" as const,
  };
  const catalog = (enabled: boolean): CodexSkillsListResponse => ({
    data: [{ cwd, skills: [{ ...skill, enabled }], errors: [] }],
  });

  it("uses the enabled catalog identity for a path-matched selection", async () => {
    const request = vi.fn(async () => catalog(true));

    await expect(resolve(request, [{ name: "release-command", path: skillPath }])).resolves.toEqual(
      [{ type: "skill", name: "release", path: skillPath }],
    );
    expect(request).toHaveBeenCalledWith(
      "skills/list",
      { cwds: [cwd], forceReload: false },
      { signal: undefined },
    );
  });

  it("skips disabled and unmatched selections", async () => {
    const request = vi.fn(async () => catalog(false));

    await expect(
      resolve(request, [
        ...selections,
        { name: "missing", path: path.join(cwd, "missing", "SKILL.md") },
      ]),
    ).resolves.toEqual([]);
  });

  it("fails open when the catalog request fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("skills/list unavailable");
    });

    await expect(resolve(request)).resolves.toEqual([]);
  });

  it("does not request the catalog without selections", async () => {
    const request = vi.fn();

    await expect(resolve(request, [])).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });
});
