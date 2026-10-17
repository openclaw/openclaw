import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import { compileMemoryWikiVault } from "./compile.js";
import { loadMemoryWikiCompiledCache } from "./compiled-cache.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import { registerMemoryWikiGatewayMethods } from "./gateway.js";
import { parseWikiMarkdown, renderWikiMarkdown } from "./markdown.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";
import { createWikiApplyTool, createWikiGetTool } from "./tool.js";

const harness = createMemoryWikiTestHarness();
const question = "Who owns the next milestone?";
const metadata = { op: "update_metadata", lookup: "entity.alpha", questions: [question] };

async function compileCount(rootDir: string): Promise<number> {
  const log = await fs.readFile(path.join(rootDir, ".openclaw-wiki", "log.jsonl"), "utf8");
  return log.split("\n").filter((line) => line.includes('"pageCounts"')).length;
}

async function createFixture(options: { missingIndex?: boolean; autoCompile?: boolean } = {}) {
  const fixture = await harness.createVault({
    initialize: true,
    config: {
      ingest: { autoCompile: options.autoCompile ?? true },
      render: { createBacklinks: false, createDashboards: false },
    },
  });
  await fs.writeFile(
    path.join(fixture.rootDir, "entities", "alpha.md"),
    renderWikiMarkdown({
      frontmatter: { pageType: "entity", id: "entity.alpha", title: "Alpha" },
      body: "# Alpha\n\nKeep this human note.\n",
    }),
    "utf8",
  );
  if (!options.missingIndex) {
    await compileMemoryWikiVault(fixture.config);
  }
  const before = await compileCount(fixture.rootDir);
  if (options.missingIndex) {
    await fs.rm(path.join(fixture.rootDir, "index.md"));
  }
  return { ...fixture, before };
}

async function applyTool(config: ResolvedMemoryWikiConfig, input: Record<string, unknown>) {
  const tool = createWikiApplyTool(config);
  const args = validateToolArguments(tool, {
    type: "toolCall",
    id: "apply-compile",
    name: tool.name,
    arguments: input,
  });
  return await tool.execute("apply-compile", args);
}

async function applyGateway(config: ResolvedMemoryWikiConfig, params: Record<string, unknown>) {
  const { api, registerGatewayMethod } = harness.createPluginApi();
  registerMemoryWikiGatewayMethods({ api, config });
  const handler = registerGatewayMethod.mock.calls.find(([name]) => name === "wiki.apply")?.[1];
  if (typeof handler !== "function") {
    throw new Error("wiki.apply handler missing");
  }
  const respond = vi.fn<(ok: boolean, payload?: unknown, error?: unknown) => void>();
  await handler({ params, respond });
  expect(respond).toHaveBeenCalledTimes(1);
  return respond.mock.calls[0];
}

async function applyCli(config: ResolvedMemoryWikiConfig, args: string[]) {
  using stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const program = new Command();
  registerWikiCli(program, { config });
  await program.parseAsync(["wiki", "apply", ...args, "--json"], { from: "user" });
  return JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join(""));
}

async function expectPublishedMutation(config: ResolvedMemoryWikiConfig, relativePath: string) {
  const page = parseWikiMarkdown(
    await fs.readFile(path.join(config.vault.path, relativePath), "utf8"),
  );
  expect(page.frontmatter.questions).toEqual([question]);
  expect(page.body).toContain(
    relativePath.startsWith("syntheses/") ? "Fresh summary." : "Keep this human note.",
  );
  await expect(fs.readFile(path.join(config.vault.path, "index.md"), "utf8")).resolves.toContain(
    relativePath,
  );
  const cache = await loadMemoryWikiCompiledCache(config);
  expect(cache?.digest.pages.find((entry) => entry.path === relativePath)?.questions).toEqual([
    question,
  ]);
}

describe("wiki apply compile ownership", () => {
  it.each(["tool", "gateway", "cli-synthesis", "cli-metadata"] as const)(
    "%s compiles once after source sync finds a missing index",
    async (entry) => {
      const { rootDir, config, before } = await createFixture({ missingIndex: true });
      let pagePath = "entities/alpha.md";
      if (entry === "tool") {
        expect((await applyTool(config, metadata)).details).toMatchObject({ changed: true });
      } else if (entry === "gateway") {
        expect(await applyGateway(config, metadata)).toEqual([
          true,
          expect.objectContaining({ changed: true }),
        ]);
      } else if (entry === "cli-synthesis") {
        pagePath = "syntheses/summary.md";
        expect(
          await applyCli(config, [
            "synthesis",
            "Summary",
            "--body",
            "Fresh summary.",
            "--source-id",
            "entity.alpha",
            "--question",
            question,
          ]),
        ).toMatchObject({ changed: true });
      } else {
        expect(
          await applyCli(config, ["metadata", "entity.alpha", "--question", question]),
        ).toMatchObject({ changed: true });
      }
      await expectPublishedMutation(config, pagePath);
      expect((await compileCount(rootDir)) - before).toBe(1);
    },
  );

  it.each([
    { name: "warm indexes", missingIndex: false, autoCompile: true },
    { name: "automatic compile disabled", missingIndex: true, autoCompile: false },
  ])("still publishes the mutation once with $name", async (options) => {
    const { rootDir, config, before } = await createFixture(options);
    await applyTool(config, metadata);
    await expectPublishedMutation(config, "entities/alpha.md");
    expect((await compileCount(rootDir)) - before).toBe(1);
  });

  it("rejects an invalid operation before source sync can repair the index", async () => {
    const { rootDir, config, before } = await createFixture({ missingIndex: true });
    const pagePath = path.join(rootDir, "entities", "alpha.md");
    const original = await fs.readFile(pagePath, "utf8");
    const invalid = { ...metadata, op: "unsupported" };
    await expect(applyTool(config, invalid)).rejects.toThrow(/Validation failed/);
    expect(await applyGateway(config, invalid)).toEqual([
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("wiki mutation op must be one of"),
      }),
    ]);
    await expect(fs.access(path.join(rootDir, "index.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(original);
    expect(await compileCount(rootDir)).toBe(before);
  });

  it("refreshes a changed import on the next wiki_get after a missing-target mutation fails", async () => {
    const fixtureRoot = await harness.createTempDir("memory-wiki-apply-recovery-");
    const notesDir = path.join(fixtureRoot, "notes");
    await fs.mkdir(notesDir);
    await fs.writeFile(path.join(notesDir, "first.md"), "First source sentinel.\n", "utf8");
    const { rootDir, config } = await harness.createVault({
      rootDir: path.join(fixtureRoot, "vault"),
      config: {
        vaultMode: "unsafe-local",
        unsafeLocal: { allowPrivateMemoryCoreAccess: true, paths: [notesDir] },
        render: { createBacklinks: false, createDashboards: false },
      },
    });
    const get = createWikiGetTool(config);
    await get.execute("warm-import", { lookup: "entity.absent" });
    const warmCache = await loadMemoryWikiCompiledCache(config);
    expect(warmCache?.digest.pages).toEqual([
      expect.objectContaining({ title: "Unsafe Local Import: first.md" }),
    ]);
    const firstPage = warmCache?.digest.pages[0];
    if (!firstPage) {
      throw new Error("Expected the initial imported page in the compiled cache");
    }
    const before = await compileCount(rootDir);
    await fs.writeFile(path.join(notesDir, "second.md"), "Second source sentinel.\n", "utf8");
    await expect(applyTool(config, { ...metadata, lookup: "entity.absent" })).rejects.toThrow(
      "Wiki page not found: entity.absent",
    );
    const importedFiles = await fs.readdir(path.join(rootDir, "sources"));
    expect(importedFiles.filter((file) => file !== "index.md")).toHaveLength(2);

    const result = await get.execute("read-after-error", { lookup: firstPage.path });
    expect(result.details).toMatchObject({
      found: true,
      content: expect.stringContaining("First source sentinel."),
    });
    await expect(fs.readFile(path.join(rootDir, "index.md"), "utf8")).resolves.toContain(
      "Unsafe Local Import: second.md",
    );
    const cache = await loadMemoryWikiCompiledCache(config);
    expect(cache?.digest.pages).toHaveLength(2);
    expect(cache?.digest.pages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Unsafe Local Import: first.md" }),
        expect.objectContaining({ title: "Unsafe Local Import: second.md" }),
      ]),
    );
    expect((await compileCount(rootDir)) - before).toBe(1);
  });
});
