import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

async function main() {
  try {
    if (!existsSync(A2UI_RENDERER_DIR) || !existsSync(A2UI_APP_DIR)) {
      if (existsSync(OUTPUT_FILE)) {
        console.log("A2UI sources missing; keeping prebuilt bundle.");
        process.exit(0);
      }
      console.error("A2UI sources missing and no prebuilt bundle found at: " + OUTPUT_FILE);
      process.exit(1);
    }

    const inputPaths = [
      path.join(ROOT_DIR, "package.json"),
      path.join(ROOT_DIR, "pnpm-lock.yaml"),
      A2UI_RENDERER_DIR,
      A2UI_APP_DIR,
    ];

    const files = [];

    async function walk(entryPath) {
      if (!existsSync(entryPath)) {
        return;
      }
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

    for (const input of inputPaths) {
      await walk(input);
    }

    function normalize(p) {
      return p.split(path.sep).join("/");
    }

    files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

    const hash = createHash("sha256");
    for (const filePath of files) {
      const rel = normalize(path.relative(ROOT_DIR, filePath));
      hash.update(rel);
      hash.update("\0");
      hash.update(await fs.readFile(filePath));
      hash.update("\0");
    }

    const currentHash = hash.digest("hex");

    if (existsSync(HASH_FILE)) {
      const previousHash = (await fs.readFile(HASH_FILE, "utf-8")).trim();
      if (previousHash === currentHash && existsSync(OUTPUT_FILE)) {
        console.log("A2UI bundle up to date; skipping.");
        process.exit(0);
      }
    }

    const tsconfigPath = path.join(A2UI_RENDERER_DIR, "tsconfig.json");
    console.log("Compiling A2UI Lit Renderer...");
    execSync(`pnpm -s exec tsc -p ${tsconfigPath}`, { stdio: "inherit", cwd: ROOT_DIR });

    const rolldownConfig = path.join(A2UI_APP_DIR, "rolldown.config.mjs");
    console.log("Rolling up A2UI App...");

    let rolldownCmd = "pnpm -s dlx rolldown";
    try {
      execSync("rolldown --version", { stdio: "ignore" });
      rolldownCmd = "rolldown";
    } catch {
      // rolldown not in PATH, use dlx
    }

    execSync(`${rolldownCmd} -c ${rolldownConfig}`, { stdio: "inherit", cwd: ROOT_DIR });

    await fs.writeFile(HASH_FILE, currentHash);
    console.log("A2UI bundle built successfully.");
  } catch (error) {
    console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
    console.error("If this persists, verify pnpm deps and try again.");
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
