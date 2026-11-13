import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDocsMarkdown, parseDocsDocument } from "./lib/docs-markdown.mjs";
const root = process.cwd();
const docs = path.join(root, "docs");
function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) =>
      e.name.startsWith(".")
        ? []
        : e.isDirectory()
          ? walk(path.join(dir, e.name))
          : e.isFile()
            ? [path.join(dir, e.name)]
            : [],
    );
}
const files = walk(docs).filter(
  (f) => /\.mdx?$/i.test(f) && !/^\/?[a-z]{2}(?:-[A-Za-z]{2,8})+\//.test(path.relative(docs, f)),
);
const rows = [];
for (const file of files) {
  const rel = path.relative(docs, file).replaceAll("\\", "/");
  const slug = rel.replace(/\.mdx?$/i, "").replace(/(?:^|\/)index$/, "");
  const pageRoute = slug ? "/" + slug.replace(/^\/+|\/+$/g, "") : "/";
  const md = createDocsMarkdown();
  const document = parseDocsDocument(fs.readFileSync(file, "utf8"), md, {
    sourceFile: file,
    root,
    pageRoute,
    mapLink: (href, line) => ({ href, line: line ?? 0 }),
  });
  const rendered = md.renderer.render(document.tokens, md.options, document.env);
  const value = JSON.stringify({
    tokens: document.tokens,
    rendered,
    ids: document.ids,
    links: document.links,
    collisions: document.collisions,
  });
  rows.push({ file: rel, sha256: crypto.createHash("sha256").update(value).digest("hex") });
}
const digest = crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const out = { files: rows.length, digest, rows };
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ files: rows.length, digest }));
