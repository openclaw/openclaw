import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { HERMES_REASON_INCLUDE_SECRETS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { writeFile } from "./test/provider-helpers.js";

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
