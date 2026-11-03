import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const target = process.argv[2];
if (!target) {
  throw new Error("Usage: copy-bootstrap-scripts.mjs <output-directory>");
}
const { files } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const file of files) {
  if (file.startsWith("scripts/") && !file.includes("*") && !file.endsWith("/")) {
    const output = join(target, file);
    mkdirSync(dirname(output), { recursive: true });
    copyFileSync(join(root, file), output);
  }
}
