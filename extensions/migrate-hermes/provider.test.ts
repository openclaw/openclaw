import fs from "node:fs/promises";
import os from "node:os";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { HERMES_REASON_INCLUDE_SECRETS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const provider = buildHermesMigrationProvider();

const fixture = useHermesFixture();
const makeTestContext = fixture.context;

function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

describe("Hermes migration provider", () => {
  it("keeps literal $ patterns in home when expanding tildes", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveHomePath("~/.hermes")).toBe(path.resolve("/home/$&user/.hermes"));
    } finally {
      spy.mockRestore();
    }
  });

  it("detects archive-only Hermes sources", async () => {
    const { source } = fixture.paths;
    await writeFile(path.join(source, "logs", "run.log"), "log line\n");

    const detected = await provider.detect?.(makeTestContext());

    expect(detected).toMatchObject({ found: true, source, confidence: "high" });
  });

  it("marks existing memory import targets as conflicts", async () => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    await writeFile(
      path.join(workspaceDir, "memory", "imports", "hermes", "MEMORY.md"),
      "existing\n",
    );

    const plan = await provider.plan(makeTestContext({ itemKinds: ["memory"] }));

    expect(itemById(plan.items, "memory:MEMORY.md")).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
  });

  it.runIf(process.platform !== "win32")(
    "marks a dangling Hermes memory destination symlink as a conflict",
    async () => {
      const { root, source, workspaceDir } = fixture.paths;
      const target = path.join(workspaceDir, "memory", "imports", "hermes", "MEMORY.md");
      await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(root, "missing-memory.md"), target);

      const plan = await provider.plan(makeTestContext({ itemKinds: ["memory"], overwrite: true }));

      expect(itemById(plan.items, "memory:MEMORY.md")).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
    },
  );

  it("copies memory bytes through the memory migration runtime", async () => {
    const { root, source } = fixture.paths;
    const workspaceDir = path.join(root, "missing-workspace");

    const sourceBytes = "remember exact bytes\n";
    await writeFile(path.join(source, "memories", "MEMORY.md"), sourceBytes);
    const context = makeTestContext({ workspaceDir, itemKinds: ["memory"] });
    const plan = await provider.plan(context);

    const result = await provider.apply(context, plan);
    const target = path.join(workspaceDir, "memory", "imports", "hermes", "MEMORY.md");

    expect(await fs.readFile(target, "utf8")).toBe(sourceBytes);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(itemById(result.items, "memory:MEMORY.md")?.status).toBe("migrated");
    expect(result.summary.migrated).toBe(1);
  });

  it.runIf(process.platform !== "win32")(
    "uses the fs-safe copier for memory-only plans applied without itemKinds",
    async () => {
      const { root, source, workspaceDir } = fixture.paths;
      const outsideDir = path.join(root, "outside");
      await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
      const plan = await provider.plan(makeTestContext({ itemKinds: ["memory"] }));
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(workspaceDir, "memory"));

      const result = await provider.apply(makeTestContext({ workspaceDir }), plan);

      expect(itemById(result.items, "memory:MEMORY.md")).toMatchObject({
        status: "error",
        reason: expect.stringContaining("path alias escape blocked"),
      });
      await expect(
        fs.access(path.join(outsideDir, "imports", "hermes", "MEMORY.md")),
      ).rejects.toThrow();
    },
  );

  it("rejects append items mixed into a memory-only copy plan", async () => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    const plan = await provider.plan(makeTestContext({ itemKinds: ["memory"] }));
    plan.items.push({
      id: "memory:mixed-append",
      kind: "memory",
      action: "append",
      status: "planned",
      source: path.join(source, "memories", "MEMORY.md"),
      target: path.join(workspaceDir, "MEMORY.md"),
    });

    await expect(provider.apply(makeTestContext({ workspaceDir }), plan)).rejects.toThrow(
      "mixes memory-only copy and append items",
    );
    await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toThrow();
  });

  it("rejects missing Hermes sources before planning", async () => {
    const root = fixture.paths.root;
    const source = path.join(root, "missing-hermes");

    await expect(provider.plan(makeTestContext({ source }))).rejects.toThrow(
      `Hermes state was not found at ${source}`,
    );
  });

  it("plans model, workspace, memory, skill, and secret items without importing secrets by default", async () => {
    const { source, workspaceDir } = fixture.paths;
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "# Existing soul\n");

    const plan = await provider.plan(makeTestContext({ model: "anthropic/claude-sonnet-4.6" }));

    expect(provider.supportedItemKinds).toEqual(["memory"]);
    expect(plan.summary).toMatchObject({ total: 6, conflicts: 2, sensitive: 1 });
    expect(itemById(plan.items, "config:default-model")?.status).toBe("conflict");
    expect(itemById(plan.items, "config:memory-plugin-slot")?.status).toBe("planned");
    expect(plan.items.some((item) => item.id.startsWith("config:model-provider:"))).toBe(false);
    expect(itemById(plan.items, "workspace:SOUL.md")?.status).toBe("conflict");
    expect(itemById(plan.items, "memory:MEMORY.md")).toMatchObject({
      action: "append",
      status: "planned",
    });
    expect(itemById(plan.items, "skill:ship-it")?.status).toBe("planned");
    expect(itemById(plan.items, "secret:openai")).toMatchObject({
      sensitive: true,
      status: "skipped",
      reason: HERMES_REASON_INCLUDE_SECRETS,
    });
    expect(plan.warnings).toEqual([
      "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
      "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
    ]);
  });
});

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
