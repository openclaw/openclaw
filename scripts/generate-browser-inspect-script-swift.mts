#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { browserFaviconScript } from "../ui/src/components/browser/browser-favicon-script.ts";
import { browserInspectScript } from "../ui/src/components/browser/browser-inspect-script.ts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const args = new Set(process.argv.slice(2));
if ([...args].some((arg) => arg !== "--check" && arg !== "--write") || args.size > 1) {
  console.error("Use either --check or --write.");
  process.exit(1);
}
const repoRoot = resolveRepoRoot(import.meta.url);
const scripts = [
  { name: "BrowserInspectScript", file: "browser-inspect-script.ts", source: browserInspectScript },
  { name: "BrowserFaviconScript", file: "browser-favicon-script.ts", source: browserFaviconScript },
];
for (const script of scripts) {
  const outputPath = path.join(
    repoRoot,
    `apps/macos/Sources/OpenClaw/${script.name}.generated.swift`,
  );
  // Avoid both raw-string terminators and Swift interpolation in the page source.
  let delimiter = "#";
  while (script.source.includes(`"""${delimiter}`) || script.source.includes(`\\${delimiter}`)) {
    delimiter += "#";
  }
  const source = script.source
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const generated = `// Generated file. Do not edit directly.
// Source: ui/src/components/browser/${script.file}
// Regenerate: pnpm gen:browser-inspect-script:swift

enum ${script.name} {
    static let source = ${delimiter}"""
${source}
    """${delimiter}
}
`;
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : null;
  if (args.has("--check")) {
    if (current !== generated) {
      console.error(
        `Out of date ${path.relative(repoRoot, outputPath)}.\nRun: pnpm gen:browser-inspect-script:swift`,
      );
      process.exit(1);
    }
    console.log(`OK ${path.relative(repoRoot, outputPath)}`);
  } else {
    if (current !== generated) {
      fs.writeFileSync(outputPath, generated);
    }
    console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
  }
}
