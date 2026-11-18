import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { hermesCase, item } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture(() => {
  vi.restoreAllMocks();
});
let h: ReturnType<typeof hermesCase>;
beforeEach(() => {
  h = hermesCase(fixture.paths.root);
});
const memoryTarget = (testCase: ReturnType<typeof hermesCase>) =>
  path.join(testCase.workspaceDir, "memory/imports/hermes/MEMORY.md");
const readSkill = (root: string, name: string) =>
  fs.readFile(path.join(root, "skills", name, "SKILL.md"), "utf8");
async function memoryCase() {
  await h.write("memories/MEMORY.md", "remember this\n");
}

describe("Hermes memory provider", () => {
  it("expands home paths without interpreting dollar patterns", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    expect(resolveHomePath("~/.hermes")).toBe(path.resolve("/home/$&user/.hermes"));
  });
  it("reports existing memory targets as conflicts", async () => {
    await memoryCase();
    await writeFile(memoryTarget(h), "existing\n");
    expect(item(await h.plan({ itemKinds: ["memory"] }), "memory:MEMORY.md")).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
  });
  it.runIf(process.platform !== "win32")(
    "rejects dangling destination symlinks even with overwrite",
    async () => {
      await memoryCase();
      const target = memoryTarget(h);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(h.root, "missing-memory.md"), target);
      expect(
        item(await h.plan({ itemKinds: ["memory"], overwrite: true }), "memory:MEMORY.md"),
      ).toMatchObject({ status: "conflict", reason: "target is not a regular file" });
    },
  );
  it("copies exact bytes privately into a missing workspace", async () => {
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
  it.runIf(process.platform !== "win32")("blocks copy escapes without itemKinds", async () => {
    await memoryCase();
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
  });
  it("rejects mixed copy/append memory plans", async () => {
    await memoryCase();
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
    const source = path.join(h.root, "missing-hermes");
    await expect(h.plan({ source })).rejects.toThrow(`Hermes state was not found at ${source}`);
  });
});

describe("Hermes skill activation policy", () => {
  it("plans skill copies despite activation conflicts", async () => {
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
    for (const [directory, skillName] of [
      ["hidden-directory", "hidden-skill"],
      ["selected-directory", "selected-skill"],
    ] as const) {
      expect(item(plan, `skill:${directory}`)).toMatchObject({
        action: "copy",
        status: "planned",
        details: { skillName },
        target: path.join(h.workspaceDir, "skills", directory),
      });
    }
    expect(item(plan, "config:skill-entry:hidden-skill")?.status).toBe("conflict");
    expect(item(plan, "config:skill-entry:selected-skill")?.status).toBe("planned");
  });
  it.each(["", "null", "true", "- name: ignored-name", "name: [unterminated"])(
    "retains directory identity for invalid frontmatter %j",
    async (frontmatter) => {
      const contents = `---\n${frontmatter}\n---\n# Review\n`;
      await h.write("skills/review-directory/SKILL.md", contents);
      expect((await h.plan()).items).toEqual([
        expect.objectContaining({
          status: "planned",
          target: path.join(h.workspaceDir, "skills/review-directory"),
          details: { skillName: "review-directory" },
        }),
      ]);
      expect(await readSkill(h.source, "review-directory")).toBe(contents);
    },
  );
  it.each(["[hidden-skill]", "hidden-skill", "\"['hidden-skill']\""])(
    "copies disabled skills without activation (%s)",
    async (disabled) => {
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
