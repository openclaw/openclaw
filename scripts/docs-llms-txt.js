#!/usr/bin/env node
/**
 * Generate progressive llms.txt files from docs-list.js.
 * Usage: node scripts/docs-llms-txt.js
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DOCS = join(process.cwd(), "docs");
const OUT = join(DOCS, ".llm");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const listResult = spawnSync("node", ["scripts/docs-list.js"], { encoding: "utf8" });
if (listResult.status !== 0 || listResult.error) {
  console.error("docs-list.js failed:", listResult.stderr || listResult.error?.message);
  process.exit(1);
}
const raw = listResult.stdout;
const lines = raw.split("\n").filter((l) => l.includes(" - ") || l.match(/^\w/));

const SKIP_CATS = new Set(["zh-CN", "ja-JP"]);

const cats = new Map();
for (const line of lines) {
  const [path, rawSummary] = line.split(" - ", 2);
  const summary = rawSummary?.startsWith("[") && rawSummary.endsWith("]") ? undefined : rawSummary;
  if (!path.endsWith(".md")) {
    continue;
  }
  const cat = path.includes("/") ? path.split("/")[0] : "_root";
  if (SKIP_CATS.has(cat)) {
    continue;
  }
  if (!cats.has(cat)) {
    cats.set(cat, []);
  }
  cats.get(cat).push({ path, title: basename(path, ".md"), summary });
}

const index = ["# OpenClaw", "", "## Categories", ""];
for (const [cat, docs] of [...cats].toSorted(([a], [b]) => a.localeCompare(b))) {
  const file = `llms-${cat === "_root" ? "root" : cat}.txt`;
  index.push(`- ${cat} (${docs.length}) → [${file}](.llm/${file})`);
  const content = docs.map((d) =>
    d.summary ? `- [${d.title}](${d.path}): ${d.summary}` : `- [${d.title}](${d.path})`,
  );
  writeFileSync(join(OUT, file), `# ${cat}\n\n${content.join("\n")}\n`);
  for (const d of docs) {
    const dest = join(OUT, d.path);
    mkdirSync(dirname(dest), { recursive: true });
    let text = readFileSync(join(DOCS, d.path), "utf8");
    text = text.replace(
      /<\/?(Columns|Card|Steps|Step|Tabs|Tab|Frame|Note|Warning|Info|Tip|Check|Accordion|AccordionGroup)\b[^>]*>/gi,
      "",
    );
    text = text.replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, "");
    text = text.replace(/<\/?p\b[^>]*>/gi, "");
    text = text.replace(/<img[^>]*\/?>/gi, "");
    text = text.replace(/\n{3,}/g, "\n\n");
    writeFileSync(dest, text);
  }
}
writeFileSync(join(OUT, "llms.txt"), index.join("\n") + "\n");

console.log(`Generated: docs/.llm/ (${cats.size} categories)`);
