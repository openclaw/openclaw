import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { hermesCase, item } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();
const makeCase = () => hermesCase(fixture.paths.root);
const memoryTarget = (h: ReturnType<typeof makeCase>) =>
  path.join(h.workspaceDir, "memory/imports/hermes/MEMORY.md");
const readSkill = (root: string, name: string) =>
  fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
async function memoryCase() {
  const h = makeCase();
  await h.write("memories/MEMORY.md", "remember this\n");
  return h;
}

describe("Hermes memory provider", () => {
  it("expands home paths without interpreting dollar patterns", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveHomePath("~/.hermes")).toBe(path.resolve("/home/$&user/.hermes"));
    } finally {
      spy.mockRestore();
    }
  });
  it("reports existing memory targets as conflicts", async () => {
    const h = await memoryCase();
    await writeFile(memoryTarget(h), "existing\n");
    expect(item(await h.plan({ itemKinds: ["memory"] }), "memory:MEMORY.md")).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
  });
  it.runIf(process.platform !== "win32")(
    "rejects dangling destination symlinks even with overwrite",
    async () => {
      const h = await memoryCase();
      const target = memoryTarget(h);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(h.root, "missing-memory.md"), target);
      expect(
        item(await h.plan({ itemKinds: ["memory"], overwrite: true }), "memory:MEMORY.md"),
      ).toMatchObject({ status: "conflict", reason: "target is not a regular file" });
    },
  );
  it("copies exact bytes privately into a missing workspace", async () => {
    const h = makeCase();
    const bytes = "remember exact bytes\n";
    await h.write("memories/MEMORY.md", bytes);
    const workspaceDir = path.join(h.root, "missing-workspace");
    const ctx = h.context({ workspaceDir, itemKinds: ["memory"] });
    const result = await h.provider.apply(ctx, await h.provider.plan(ctx));
    const target = path.join(workspaceDir, "memory/imports/hermes/MEMORY.md");
    expect(await fs.readFile(target, "utf8")).toBe(bytes);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(item(result, "memory:MEMORY.md")?.status).toBe("migrated");
    expect(result.summary.migrated).toBe(1);
  });
  it.runIf(process.platform !== "win32")(
    "keeps fs-safe copying when apply omits itemKinds",
    async () => {
      const h = await memoryCase();
      const plan = await h.plan({ itemKinds: ["memory"] });
      const outside = path.join(h.root, "outside");
      await fs.mkdir(h.workspaceDir, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, path.join(h.workspaceDir, "memory"));
      expect(item(await h.apply({}, plan), "memory:MEMORY.md")).toMatchObject({
        status: "error",
        reason: expect.stringContaining("path alias escape blocked"),
      });
      await expect(fs.access(path.join(outside, "imports/hermes/MEMORY.md"))).rejects.toThrow();
    },
  );
  it("rejects append items mixed into memory-only copy plans", async () => {
    const h = await memoryCase();
    const plan = await h.plan({ itemKinds: ["memory"] });
    plan.items.push({
      id: "memory:mixed-append",
      kind: "memory",
      action: "append",
      status: "planned",
      source: path.join(h.source, "memories/MEMORY.md"),
      target: path.join(h.workspaceDir, "MEMORY.md"),
    });
    await expect(h.apply({}, plan)).rejects.toThrow("mixes memory-only copy and append items");
    await expect(fs.access(path.join(h.workspaceDir, "MEMORY.md"))).rejects.toThrow();
  });
  it("rejects missing sources", async () => {
    const h = makeCase();
    const source = path.join(h.root, "missing-hermes");
    await expect(h.plan({ source })).rejects.toThrow(`Hermes state was not found at ${source}`);
  });
});

describe("Hermes skill activation policy", () => {
  it("keeps copies independent from conflicting activation entries", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      "skills:\n  disabled: [hidden-skill]\n  config:\n    hidden-skill:\n      mode: careful\n    selected-skill:\n      mode: fast\n",
    );
    await h.write("skills/hidden-directory/SKILL.md", "---\nname: hidden-skill\n---\n");
    await h.write(
      "skills/selected-directory/SKILL.md",
      "\uFEFF---\r\nname: selected-skill\r\n---\r\n",
    );
    h.config.skills = { entries: { "hidden-skill": { enabled: true } } };
    const plan = await h.plan({ config: h.config });
    expect(plan.items.filter((entry) => entry.kind === "skill")).toEqual(
      (
        [
          ["hidden-directory", "hidden-skill"],
          ["selected-directory", "selected-skill"],
        ] as const
      ).map(([directory, skillName]) =>
        expect.objectContaining({
          action: "copy",
          status: "planned",
          target: path.join(h.workspaceDir, "skills", directory),
          details: expect.objectContaining({ skillName }),
        }),
      ),
    );
    expect(plan.items.filter((entry) => entry.kind === "config")).toEqual([
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
    "",
    "# No name",
    "null",
    "true",
    "42",
    "ignored-name",
    "- name: ignored-name",
    "name: [unterminated",
  ])("retains directory identity for invalid frontmatter %j", async (frontmatter) => {
    const h = makeCase();
    const contents = `---\n${frontmatter}\n---\n# Review\n`;
    await h.write("skills/review-directory/SKILL.md", contents);
    expect((await h.plan()).items).toEqual([
      expect.objectContaining({
        id: "skill:review-directory",
        kind: "skill",
        action: "copy",
        status: "planned",
        source: path.join(h.source, "skills/review-directory"),
        target: path.join(h.workspaceDir, "skills/review-directory"),
        details: { skillName: "review-directory" },
      }),
    ]);
    expect(await readSkill(h.source, "review-directory")).toBe(contents);
  });
  it.each(["[hidden-skill]", "hidden-skill", "\"['hidden-skill']\""])(
    "imports disabled skills without enabling them (%s)",
    async (disabled) => {
      const h = makeCase();
      await h.write(
        "config.yaml",
        `skills:\n  disabled: ${disabled}\n  config:\n    hidden-skill:\n      mode: careful\n`,
      );
      const contents = "---\nname: hidden-skill\ndescription: Hidden skill\n---\n# Hidden\n";
      await h.write("skills/hidden-skill/SKILL.md", contents);
      expect((await h.import()).summary.errors).toBe(0);
      expect(h.config.skills?.entries?.["hidden-skill"]).toEqual({
        config: { mode: "careful" },
        enabled: false,
      });
      expect(await readSkill(h.workspaceDir, "hidden-skill")).toBe(contents);
    },
  );
  it.each([undefined, "current", "../previous"])(
    "imports only the active organization mirror (%s)",
    async (active) => {
      const h = makeCase();
      for (const org of ["current", "previous"]) {
        await h.write(`skills/_org/${org}/review/SKILL.md`, `# ${org} review\n`);
      }
      await h.write("skills/personal/SKILL.md", "# Personal\n");
      if (active) {
        await h.write("skills/_org/.active_org", `${active}\n`);
      }
      const valid = active === "current" || active === "previous";
      const plan = await h.plan();
      expect(plan.items.filter((entry) => entry.kind === "skill").map((entry) => entry.id)).toEqual(
        [...(valid ? [`skill:_org:${active}:review`] : []), "skill:personal"],
      );
      expect(plan.summary.conflicts).toBe(0);
      expect((await h.apply({}, plan)).summary.errors).toBe(0);
      if (valid) {
        expect(await readSkill(h.workspaceDir, "review")).toBe(`# ${active} review\n`);
      } else {
        await expect(fs.access(path.join(h.workspaceDir, "skills/review"))).rejects.toThrow();
      }
    },
  );
});
