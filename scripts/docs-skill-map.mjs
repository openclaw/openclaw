#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAP_RELATIVE_PATH = "skills/openclaw-docs/references/docs-map.md";
const HEADER = [
  "# OpenClaw docs map",
  "",
  "Generated from `docs/docs.json` by `pnpm docs:skill-map:gen`. Do not edit by hand.",
  "Page `x/y` is `<docs>/x/y.md` locally and `https://docs.openclaw.ai/x/y` on the web.",
  "Pages marked (web only) are published but not shipped in local docs.",
].join("\n");

function flattenPages(group) {
  const pages = [];
  for (const page of group.pages ?? []) {
    if (typeof page === "string") {
      pages.push(page);
    } else {
      pages.push(...flattenPages(page));
    }
  }
  return pages;
}

function compressPages(pages) {
  const byDir = new Map();
  for (const page of pages) {
    const slash = page.lastIndexOf("/");
    const dir = slash < 0 ? "" : page.slice(0, slash);
    const leaves = byDir.get(dir) ?? [];
    leaves.push(page.slice(slash + 1));
    byDir.set(dir, leaves);
  }
  return [...byDir]
    .map(([dir, leaves]) =>
      dir === ""
        ? leaves.join(" ")
        : leaves.length === 1
          ? `${dir}/${leaves[0]}`
          : `${dir}/{${leaves.join(",")}}`,
    )
    .join(" ");
}

export function renderDocsSkillMap(docsDir) {
  const docs = JSON.parse(readFileSync(join(docsDir, "docs.json"), "utf8"));
  const english = docs.navigation.languages.find((entry) => entry.language === "en");
  const isLocal = (page) =>
    existsSync(join(docsDir, `${page}.md`)) || existsSync(join(docsDir, `${page}.mdx`));
  const sections = [HEADER];
  for (const tab of english.tabs) {
    const lines = [`## ${tab.tab}`, ""];
    for (const group of tab.groups ?? []) {
      const pages = flattenPages(group);
      const local = pages.filter(isLocal);
      const webOnly = pages.filter((page) => !isLocal(page));
      const parts = [local.length > 0 ? ` ${compressPages(local)}` : ""];
      if (webOnly.length > 0) {
        parts.push(` (web only: ${compressPages(webOnly)})`);
      }
      lines.push(`- ${group.group}:${parts.join("")}`);
    }
    sections.push(lines.join("\n"));
  }
  return `${sections.join("\n\n")}\n`;
}

function main(argv = process.argv.slice(2)) {
  const mode = argv.length === 1 ? argv[0] : undefined;
  if (mode !== "--write" && mode !== "--check") {
    console.error("Usage: node scripts/docs-skill-map.mjs --write | --check");
    process.exitCode = 1;
    return;
  }
  const mapPath = join(process.cwd(), MAP_RELATIVE_PATH);
  const expected = renderDocsSkillMap(join(process.cwd(), "docs"));
  if (mode === "--write") {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, expected);
    return;
  }
  if (!existsSync(mapPath) || readFileSync(mapPath, "utf8") !== expected) {
    console.error(`${MAP_RELATIVE_PATH} is stale or missing. Run: pnpm docs:skill-map:gen`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
