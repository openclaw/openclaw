#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/**
 * 基于 docs-list.js 生成渐进式 llms.txt
 * 用法: node scripts/docs-llms-txt.js
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DOCS = join(process.cwd(), "docs");
const OUT = join(DOCS, ".llm");
mkdirSync(OUT, { recursive: true });

const raw = spawnSync("node", ["scripts/docs-list.js"], { encoding: "utf8" }).stdout;
const lines = raw.split("\n").filter((l) => l.includes(" - ") || l.match(/^\w/));

const SKIP_CATS = new Set(["zh-CN", "ja-JP"]);

const cats = new Map();
for (const line of lines) {
  const [path, summary] = line.split(" - ", 2);
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
      /<(Columns|Card|Steps|Step|Tabs|Tab|Frame|Note|Warning|Info|Tip|Check|Accordion|AccordionGroup)[^>]*>[\s\S]*?<\/\1>/gi,
      "",
    );
    text = text.replace(
      /<(Columns|Card|Steps|Step|Tabs|Tab|Frame|Note|Warning|Info|Tip|Check|Accordion|AccordionGroup)[^>]*\/>/gi,
      "",
    );
    text = text.replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, "");
    text = text.replace(/<p[^>]*>[\s\S]*?<\/p>/gi, "");
    text = text.replace(/<img[^>]*\/?>/gi, "");
    text = text.replace(/\n{3,}/g, "\n\n");
    writeFileSync(dest, text);
  }
}
writeFileSync(join(OUT, "llms.txt"), index.join("\n") + "\n");

console.log(`生成: docs/.llm/ (${cats.size} 分类)`);
