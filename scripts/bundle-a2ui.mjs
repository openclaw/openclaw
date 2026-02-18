import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

async function main() {
  try {
    // Check if sources exist
    if (!existsSync(A2UI_RENDERER_DIR) || !existsSync(A2UI_APP_DIR)) {
      if (existsSync(OUTPUT_FILE)) {
        console.log("A2UI sources missing; keeping prebuilt bundle.");
        process.exit(0);
      }
      console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
      process.exit(1);
    }

    const INPUT_PATHS = [
      path.join(ROOT_DIR, "package.json"),
      path.join(ROOT_DIR, "pnpm-lock.yaml"),
      A2UI_RENDERER_DIR,
      A2UI_APP_DIR
    ];

    const files = [];
    async function walk(entryPath) {
      const st = await fs.stat(entryPath);
      if (st.isDirectory()) {
        const entries = await fs.readdir(entryPath);
        for (const entry of entries) {
          await walk(path.join(entryPath, entry));
        }
        return;
      }
      files.push(entryPath);
    }

    for (const input of INPUT_PATHS) {
      if (existsSync(input)) {
        await walk(input);
      }
    }

    function normalize(p) {
      return path.relative(ROOT_DIR, p).split(path.sep).join("/");
    }

    files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

    const hash = createHash("sha256");
    for (const filePath of files) {
      const rel = normalize(filePath);
      hash.update(rel);
      hash.update("\0");
      hash.update(await fs.readFile(filePath));
      hash.update("\0");
    }

    const current_hash = hash.digest("hex");

    if (existsSync(HASH_FILE)) {
      const previous_hash = await fs.readFile(HASH_FILE, "utf-8");
      if (previous_hash.trim() === current_hash && existsSync(OUTPUT_FILE)) {
        console.log("A2UI bundle up to date; skipping.");
        process.exit(0);
      }
    }

    console.log("Building A2UI bundle...");
    
    // Run tsc
    execSync(`pnpm -s exec tsc -p "${path.join(A2UI_RENDERER_DIR, "tsconfig.json")}"`, { stdio: "inherit", cwd: ROOT_DIR });
    
    // Run rolldown
    execSync(`pnpm exec rolldown -c "${path.join(A2UI_APP_DIR, "rolldown.config.mjs")}"`, { stdio: "inherit", cwd: ROOT_DIR });

    await fs.writeFile(HASH_FILE, current_hash);
    console.log("A2UI bundle built successfully.");

  } catch (err) {
    console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
    console.error(err);
    process.exit(1);
  }
}

main();
