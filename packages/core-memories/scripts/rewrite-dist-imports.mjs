import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Rewrites extensionless relative imports in dist/*.js to include the `.js` extension.
 *
 * Why: we use TS moduleResolution=bundler so sources can write `./index` and `./session-continuation`,
 * but Node ESM requires explicit extensions at runtime.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, "..", "dist");

const replacements = [
  // Most important entrypoints
  { from: 'from "./index"', to: 'from "./index.js"' },
  { from: 'from "./session-continuation"', to: 'from "./session-continuation.js"' },
  { from: 'from "./integration"', to: 'from "./integration.js"' },
];

async function rewriteFile(filePath) {
  let text = await fs.readFile(filePath, "utf8");
  let changed = false;
  for (const r of replacements) {
    if (text.includes(r.from)) {
      text = text.replaceAll(r.from, r.to);
      changed = true;
    }
  }
  if (changed) {
    await fs.writeFile(filePath, text, "utf8");
  }
}

async function main() {
  const entries = await fs.readdir(distDir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((e) => e.isFile() && e.name.endsWith(".js"))
      .map((e) => rewriteFile(path.join(distDir, e.name))),
  );
}

await main();
