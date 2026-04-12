import { promises as fs } from "node:fs";
import path from "node:path";

const baseDir = path.resolve("skills/line-sticker/references");

function stripSceneChar(value) {
  if (Array.isArray(value)) {
    return value.map(stripSceneChar);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === "scene" || key === "char") continue;
      out[key] = stripSceneChar(v);
    }
    return out;
  }
  return value;
}

const entries = await fs.readdir(baseDir);
const targets = entries
  .filter((name) => /^package-.*\.json$/i.test(name))
  .map((name) => path.join(baseDir, name))
  .sort();

let changed = 0;
for (const file of targets) {
  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  const stripped = stripSceneChar(parsed);
  const next = `${JSON.stringify(stripped, null, 2)}\n`;
  if (next !== raw) {
    await fs.writeFile(file, next, "utf8");
    changed += 1;
    console.log(`updated: ${path.basename(file)}`);
  } else {
    console.log(`unchanged: ${path.basename(file)}`);
  }
}

console.log(`done: ${changed}/${targets.length} files updated`);
