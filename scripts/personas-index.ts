#!/usr/bin/env bun
/**
 * Generate `agents/personas/_index.json` from all persona `.md` files.
 *
 * Parses YAML frontmatter from each `agents/personas/{category}/*.md` file,
 * validates against PersonaFrontmatterSchema, and writes the index manifest.
 *
 * Usage: `bun scripts/personas-index.ts` or `pnpm personas:index`
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { PersonaFrontmatterSchema } from "../src/config/zod-schema.persona.js";
import type {
  PersonaIndex,
  PersonaIndexEntry,
  PersonaCategory,
} from "../src/config/zod-schema.persona.js";

const PERSONAS_DIR = join(import.meta.dirname, "..", "agents", "personas");
const INDEX_PATH = join(PERSONAS_DIR, "_index.json");
const FRONTMATTER_SPLIT_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

async function main() {
  const categoryDirs = await readdir(PERSONAS_DIR, { withFileTypes: true });
  const personas: PersonaIndexEntry[] = [];
  const categoryMap = new Map<string, { name: string; count: number }>();
  let errors = 0;

  for (const entry of categoryDirs.filter((e) => e.isDirectory())) {
    const categoryDir = join(PERSONAS_DIR, entry.name);
    const files = await readdir(categoryDir);
    const mdFiles = files.filter((f) => f.endsWith(".md"));

    for (const file of mdFiles) {
      const filePath = join(categoryDir, file);
      const content = await readFile(filePath, "utf-8");
      const match = FRONTMATTER_SPLIT_RE.exec(content);
      if (!match) {
        console.error(`  SKIP ${entry.name}/${file}: no valid frontmatter`);
        errors++;
        continue;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(match[1]);
      } catch (err) {
        console.error(`  SKIP ${entry.name}/${file}: invalid YAML — ${(err as Error).message}`);
        errors++;
        continue;
      }

      const result = PersonaFrontmatterSchema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
        console.error(`  FAIL ${entry.name}/${file}: ${issues.join(", ")}`);
        errors++;
        continue;
      }

      const fm = result.data;
      const relPath = relative(PERSONAS_DIR, filePath);

      personas.push({
        slug: fm.slug,
        name: fm.name,
        description: fm.description,
        category: fm.category,
        role: fm.role,
        department: fm.department,
        emoji: fm.emoji,
        tags: fm.tags,
        path: relPath,
      });

      const existing = categoryMap.get(fm.category);
      if (existing) {
        existing.count++;
      } else {
        // Title-case the category name
        const displayName = fm.category
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");
        categoryMap.set(fm.category, { name: displayName, count: 1 });
      }
    }
  }

  // Sort personas by category then slug
  personas.sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

  const categories: PersonaCategory[] = Array.from(categoryMap.entries())
    .map(([slug, { name, count }]) => ({ slug, name, count }))
    .toSorted((a, b) => a.slug.localeCompare(b.slug));

  const index: PersonaIndex = {
    version: 1,
    generated: new Date().toISOString(),
    personas,
    categories,
  };

  await writeFile(INDEX_PATH, JSON.stringify(index, null, 2) + "\n", "utf-8");

  console.log(`Generated ${INDEX_PATH}`);
  console.log(`  ${personas.length} personas across ${categories.length} categories`);
  if (errors > 0) {
    console.error(`  ${errors} files had validation errors`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
