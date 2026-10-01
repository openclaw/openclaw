import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

let workspace: TempWorkspace;

describe("Hermes skill activation policy migration", () => {
  beforeEach(async () => {
    workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-hermes-skills-policy-",
    });
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it("plans skill config and disabled state as independently conflicting entries", async () => {
    const source = path.join(workspace.dir, "hermes");
    const workspaceDir = path.join(workspace.dir, "workspace");
    await writeFile(
      path.join(source, "config.yaml"),
      "skills:\n  disabled: [hidden-skill]\n  config:\n    hidden-skill:\n      mode: careful\n    selected-skill:\n      mode: fast\n",
    );
    await writeFile(
      path.join(source, "skills", "hidden-directory", "SKILL.md"),
      "---\nname: hidden-skill\ndescription: Hidden skill\n---\n",
    );
    await writeFile(
      path.join(source, "skills", "selected-directory", "SKILL.md"),
      "\uFEFF---\r\nname: selected-skill\r\ndescription: Selected skill\r\n---\r\n",
    );
    const ctx = makeContext({ source, stateDir: path.join(workspace.dir, "state"), workspaceDir });
    ctx.config.skills = { entries: { "hidden-skill": { enabled: true } } };

    const plan = await buildHermesMigrationProvider().plan(ctx);

    expect(plan.items.filter((item) => item.kind === "skill")).toEqual([
      expect.objectContaining({
        action: "copy",
        status: "planned",
        target: path.join(workspaceDir, "skills", "hidden-directory"),
        details: expect.objectContaining({ skillName: "hidden-skill" }),
      }),
      expect.objectContaining({
        action: "copy",
        status: "planned",
        target: path.join(workspaceDir, "skills", "selected-directory"),
        details: expect.objectContaining({ skillName: "selected-skill" }),
      }),
    ]);
    expect(plan.items.filter((item) => item.kind === "config")).toEqual([
      expect.objectContaining({
        status: "conflict",
        details: {
          path: ["skills", "entries", "hidden-skill"],
          value: { config: { mode: "careful" }, enabled: false },
        },
      }),
      expect.objectContaining({
        status: "planned",
        details: {
          path: ["skills", "entries", "selected-skill"],
          value: { config: { mode: "fast" } },
        },
      }),
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
    const source = path.join(workspace.dir, "hermes");
    const workspaceDir = path.join(workspace.dir, "workspace");
    const skillSource = path.join(source, "skills", "review-directory");
    const contents = `---\n${frontmatter}\n---\n# Review\n`;
    await writeFile(path.join(skillSource, "SKILL.md"), contents);

    const plan = await buildHermesMigrationProvider().plan(
      makeContext({ source, stateDir: path.join(workspace.dir, "state"), workspaceDir }),
    );

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
    expect(await fs.readFile(path.join(skillSource, "SKILL.md"), "utf8")).toBe(contents);
  });

  it.each([
    ["YAML list", "[hidden-skill]"],
    ["scalar name", "hidden-skill"],
    ["Python literal array string", "\"['hidden-skill']\""],
  ])("keeps globally disabled skills disabled from a %s", async (_, disabled) => {
    const source = path.join(workspace.dir, "hermes");
    const workspaceDir = path.join(workspace.dir, "workspace");
    await writeFile(
      path.join(source, "config.yaml"),
      `skills:\n  disabled: ${disabled}\n  config:\n    hidden-skill:\n      mode: careful\n`,
    );
    const skillContents = "---\nname: hidden-skill\ndescription: Hidden skill\n---\n# Hidden\n";
    await writeFile(path.join(source, "skills", "hidden-skill", "SKILL.md"), skillContents);
    const ctx = makeContext({ source, stateDir: path.join(workspace.dir, "state"), workspaceDir });
    ctx.runtime = makeConfigRuntime(ctx.config);

    const result = await buildHermesMigrationProvider().apply(ctx);

    expect(result.summary.errors).toBe(0);
    expect(ctx.config.skills?.entries?.["hidden-skill"]).toEqual({
      config: { mode: "careful" },
      enabled: false,
    });
    expect(
      await fs.readFile(path.join(workspaceDir, "skills", "hidden-skill", "SKILL.md"), "utf8"),
    ).toBe(skillContents);
  });

  it.each([undefined, "current", "../previous"])(
    "imports only the active organization mirror (%s)",
    async (activeOrg) => {
      const source = path.join(workspace.dir, "hermes");
      const workspaceDir = path.join(workspace.dir, "workspace");
      for (const org of ["current", "previous"]) {
        await writeFile(
          path.join(source, "skills", "_org", org, "review", "SKILL.md"),
          `# ${org} review\n`,
        );
      }
      await writeFile(path.join(source, "skills", "personal", "SKILL.md"), "# Personal\n");
      if (activeOrg) {
        await writeFile(path.join(source, "skills", "_org", ".active_org"), `${activeOrg}\n`);
      }
      const provider = buildHermesMigrationProvider();
      const ctx = makeContext({
        source,
        stateDir: path.join(workspace.dir, "state"),
        workspaceDir,
      });
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
        expect(
          await fs.readFile(path.join(workspaceDir, "skills", "review", "SKILL.md"), "utf8"),
        ).toBe(`# ${activeOrg} review\n`);
      } else {
        await expect(fs.access(path.join(workspaceDir, "skills", "review"))).rejects.toThrow();
      }
    },
  );
});
