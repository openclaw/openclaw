import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "./helpers.js";
import { HERMES_REASON_INCLUDE_SECRETS } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { makeContext, makeHermesPaths, writeFile } from "./test/provider-helpers.js";

let testWorkspace: TempWorkspace;

function itemById(
  items: Array<{ id: string; [key: string]: unknown }>,
  id: string,
): { id: string; [key: string]: unknown } | undefined {
  return items.find((item) => item.id === id);
}

describe("Hermes migration provider", () => {
  beforeEach(async () => {
    testWorkspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: "openclaw-migrate-hermes-",
    });
  });

  afterEach(async () => {
    await testWorkspace.cleanup();
  });

  it("keeps literal $ patterns in home when expanding tildes", () => {
    const spy = vi.spyOn(os, "homedir").mockReturnValue("/home/$&user");
    try {
      expect(resolveHomePath("~/.hermes")).toBe(path.resolve("/home/$&user/.hermes"));
    } finally {
      spy.mockRestore();
    }
  });

  it("detects archive-only Hermes sources", async () => {
    const { root, source } = makeHermesPaths(testWorkspace.dir);
    await writeFile(path.join(source, "logs", "run.log"), "log line\n");

    const provider = buildHermesMigrationProvider();
    const detected = await provider.detect?.(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir: path.join(root, "workspace"),
      }),
    );

    expect(detected?.found).toBe(true);
    expect(detected?.source).toBe(source);
    expect(detected?.confidence).toBe("high");
  });

  it("marks existing memory import targets as conflicts", async () => {
    const { root, source, workspaceDir } = makeHermesPaths(testWorkspace.dir);
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    await writeFile(
      path.join(workspaceDir, "memory", "imports", "hermes", "MEMORY.md"),
      "existing\n",
    );
    const provider = buildHermesMigrationProvider();

    const plan = await provider.plan(
      makeContext({
        source,
        stateDir: path.join(root, "state"),
        workspaceDir,
        itemKinds: ["memory"],
      }),
    );

    expect(itemById(plan.items, "memory:MEMORY.md")).toMatchObject({
      status: "conflict",
      reason: "target exists",
    });
  });

  it.runIf(process.platform !== "win32")(
    "marks a dangling Hermes memory destination symlink as a conflict",
    async () => {
      const { root, source, workspaceDir } = makeHermesPaths(testWorkspace.dir);
      const target = path.join(workspaceDir, "memory", "imports", "hermes", "MEMORY.md");
      await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.symlink(path.join(root, "missing-memory.md"), target);
      const provider = buildHermesMigrationProvider();

      const plan = await provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir,
          itemKinds: ["memory"],
          overwrite: true,
        }),
      );

      expect(itemById(plan.items, "memory:MEMORY.md")).toMatchObject({
        status: "conflict",
        reason: "target is not a regular file",
      });
    },
  );

  it("copies memory bytes through the memory migration runtime", async () => {
    const { root, source } = makeHermesPaths(testWorkspace.dir);
    const workspaceDir = path.join(root, "missing-workspace");
    const stateDir = path.join(root, "state");
    const sourceBytes = "remember exact bytes\n";
    await writeFile(path.join(source, "memories", "MEMORY.md"), sourceBytes);
    const provider = buildHermesMigrationProvider();
    const context = makeContext({
      source,
      stateDir,
      workspaceDir,
      itemKinds: ["memory"],
    });
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
      const { root, source, workspaceDir, stateDir } = makeHermesPaths(testWorkspace.dir);
      const outsideDir = path.join(root, "outside");
      await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
      const provider = buildHermesMigrationProvider();
      const plan = await provider.plan(
        makeContext({ source, stateDir, workspaceDir, itemKinds: ["memory"] }),
      );
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.symlink(outsideDir, path.join(workspaceDir, "memory"));

      const result = await provider.apply(makeContext({ source, stateDir, workspaceDir }), plan);

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
    const { source, workspaceDir, stateDir } = makeHermesPaths(testWorkspace.dir);
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({ source, stateDir, workspaceDir, itemKinds: ["memory"] }),
    );
    plan.items.push({
      id: "memory:mixed-append",
      kind: "memory",
      action: "append",
      status: "planned",
      source: path.join(source, "memories", "MEMORY.md"),
      target: path.join(workspaceDir, "MEMORY.md"),
    });

    await expect(
      provider.apply(makeContext({ source, stateDir, workspaceDir }), plan),
    ).rejects.toThrow("mixes memory-only copy and append items");
    await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toThrow();
  });

  it("rejects missing Hermes sources before planning", async () => {
    const root = testWorkspace.dir;
    const source = path.join(root, "missing-hermes");

    const provider = buildHermesMigrationProvider();

    await expect(
      provider.plan(
        makeContext({
          source,
          stateDir: path.join(root, "state"),
          workspaceDir: path.join(root, "workspace"),
        }),
      ),
    ).rejects.toThrow(`Hermes state was not found at ${source}`);
  });

  it("plans model, workspace, memory, skill, and secret items without importing secrets by default", async () => {
    const { source, workspaceDir, stateDir } = makeHermesPaths(testWorkspace.dir);
    await writeFile(
      path.join(source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
    await writeFile(path.join(source, ".env"), "OPENAI_API_KEY=sk-hermes\n");
    await writeFile(path.join(source, "SOUL.md"), "# Hermes soul\n");
    await writeFile(path.join(source, "memories", "MEMORY.md"), "remember this\n");
    await writeFile(path.join(source, "skills", "Ship It", "SKILL.md"), "# Ship It\n");
    await writeFile(path.join(workspaceDir, "SOUL.md"), "# Existing soul\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        model: "anthropic/claude-sonnet-4.6",
      }),
    );

    expect(provider.supportedItemKinds).toEqual(["memory"]);
    expect(plan.summary.total).toBe(6);
    expect(plan.summary.conflicts).toBe(2);
    expect(plan.summary.sensitive).toBe(1);
    expect(itemById(plan.items, "config:default-model")?.status).toBe("conflict");
    expect(itemById(plan.items, "config:memory-plugin-slot")?.status).toBe("planned");
    expect(plan.items.some((item) => item.id.startsWith("config:model-provider:"))).toBe(false);
    expect(itemById(plan.items, "workspace:SOUL.md")?.status).toBe("conflict");
    const memory = itemById(plan.items, "memory:MEMORY.md");
    expect(memory?.action).toBe("append");
    expect(memory?.status).toBe("planned");
    expect(itemById(plan.items, "skill:ship-it")?.status).toBe("planned");
    const secret = itemById(plan.items, "secret:openai");
    expect(secret?.sensitive).toBe(true);
    expect(secret?.status).toBe("skipped");
    expect(secret?.reason).toBe(HERMES_REASON_INCLUDE_SECRETS);
    expect(plan.warnings).toEqual([
      "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
      "Conflicts were found. Re-run with --overwrite to replace conflicting targets after item-level backups.",
    ]);
  });
});
