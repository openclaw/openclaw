import "openclaw/plugin-sdk/compiled-subprocess-testing";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();
const provider = buildHermesMigrationProvider();
const readSkill = (root: string, name: string) =>
  fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
const writeSkill = (name: string, content: string) =>
  writeFile(path.join(fixture.paths.source, "skills", name, "SKILL.md"), content);
const plannedCopy = (directory: string, skillName: string) =>
  expect.objectContaining({
    action: "copy",
    status: "planned",
    target: path.join(fixture.paths.workspaceDir, "skills", directory),
    details: expect.objectContaining({ skillName }),
  });
const configEntry = (name: string, value: object, status = "planned") =>
  expect.objectContaining({ status, details: { path: ["skills", "entries", name], value } });

describe("Hermes skill activation policy migration", () => {
  it("plans skill config and disabled state as independently conflicting entries", async () => {
    const { source } = fixture.paths;
    await writeFile(
      path.join(source, "config.yaml"),
      "skills:\n  disabled: [hidden-skill]\n  config:\n    hidden-skill:\n      mode: careful\n    selected-skill:\n      mode: fast\n",
    );
    await writeSkill("hidden-directory", "---\nname: hidden-skill\n---\n");
    await writeSkill("selected-directory", "\uFEFF---\r\nname: selected-skill\r\n---\r\n");
    const ctx = fixture.context();
    ctx.config.skills = { entries: { "hidden-skill": { enabled: true } } };

    const plan = await provider.plan(ctx);

    expect(plan.items.filter((item) => item.kind === "skill")).toEqual([
      plannedCopy("hidden-directory", "hidden-skill"),
      plannedCopy("selected-directory", "selected-skill"),
    ]);
    expect(plan.items.filter((item) => item.kind === "config")).toEqual([
      configEntry("hidden-skill", { config: { mode: "careful" }, enabled: false }, "conflict"),
      configEntry("selected-skill", { config: { mode: "fast" } }),
    ]);
  });

  it.each([
    ["empty", ""],
    ["comment-only", "# No name"],
    ["null", "null"],
    ["boolean", "true"],
    ["number", "42"],
    ["string", "ignored-name"],
    ["sequence", "- name: ignored-name"],
    ["malformed", "name: [unterminated"],
  ])("keeps the directory name and planned copy for %s frontmatter", async (_, frontmatter) => {
    const { source, workspaceDir } = fixture.paths;
    const skillSource = path.join(source, "skills", "review-directory");
    const contents = `---\n${frontmatter}\n---\n# Review\n`;
    await writeSkill("review-directory", contents);

    const plan = await provider.plan(fixture.context());

    expect(plan.items).toEqual([
      expect.objectContaining({
        id: "skill:review-directory",
        kind: "skill",
        action: "copy",
        status: "planned",
        source: skillSource,
        target: path.join(workspaceDir, "skills", "review-directory"),
        details: { skillName: "review-directory" },
      }),
    ]);
    expect(await readSkill(source, "review-directory")).toBe(contents);
  });

  it.each([
    ["YAML list", "[hidden-skill]"],
    ["scalar name", "hidden-skill"],
    ["Python literal array string", "\"['hidden-skill']\""],
  ])("keeps globally disabled skills disabled from a %s", async (_, disabled) => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(
      path.join(source, "config.yaml"),
      `skills:\n  disabled: ${disabled}\n  config:\n    hidden-skill:\n      mode: careful\n`,
    );
    const skillContents = "---\nname: hidden-skill\ndescription: Hidden skill\n---\n# Hidden\n";
    await writeSkill("hidden-skill", skillContents);
    const ctx = fixture.context();
    ctx.runtime = makeConfigRuntime(ctx.config);

    const result = await provider.apply(ctx);

    expect(result.summary.errors).toBe(0);
    expect(ctx.config.skills?.entries?.["hidden-skill"]).toEqual({
      config: { mode: "careful" },
      enabled: false,
    });
    expect(await readSkill(workspaceDir, "hidden-skill")).toBe(skillContents);
  });

  it.each([undefined, "current", "../previous"])(
    "imports only the active organization mirror (%s)",
    async (activeOrg) => {
      const { source, workspaceDir } = fixture.paths;
      for (const org of ["current", "previous"]) {
        await writeSkill(`_org/${org}/review`, `# ${org} review\n`);
      }
      await writeSkill("personal", "# Personal\n");
      if (activeOrg) {
        await writeFile(path.join(source, "skills", "_org", ".active_org"), `${activeOrg}\n`);
      }
      const ctx = fixture.context();
      const plan = await provider.plan(ctx);
      const validOrg = activeOrg === "current" || activeOrg === "previous";

      expect(plan.items.filter((item) => item.kind === "skill").map((item) => item.id)).toEqual([
        ...(validOrg ? [`skill:_org:${activeOrg}:review`] : []),
        "skill:personal",
      ]);
      expect(plan.summary.conflicts).toBe(0);
      const result = await provider.apply(ctx, plan);
      expect(result.summary.errors).toBe(0);
      if (validOrg) {
        expect(await readSkill(workspaceDir, "review")).toBe(`# ${activeOrg} review\n`);
      } else {
        await expect(fs.access(path.join(workspaceDir, "skills", "review"))).rejects.toThrow();
      }
    },
  );
});
