import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
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
  // Check input directories
  const rendererExists = existsSync(A2UI_RENDERER_DIR);
  const appExists = existsSync(A2UI_APP_DIR);

  if (!rendererExists || !appExists) {
    if (existsSync(OUTPUT_FILE)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      process.exit(0);
    }
    console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
    process.exit(1);
  }

  const inputPaths = [
    path.join(ROOT_DIR, "package.json"),
    path.join(ROOT_DIR, "pnpm-lock.yaml"),
    A2UI_RENDERER_DIR,
    A2UI_APP_DIR,
  ];

  const currentHash = await computeHash(inputPaths);

  if (existsSync(HASH_FILE)) {
    const previousHash = readFileSync(HASH_FILE, "utf-8").trim();
    if (previousHash === currentHash && existsSync(OUTPUT_FILE)) {
      console.log("A2UI bundle up to date; skipping.");
      process.exit(0);
    }
  }

  console.log("Building A2UI bundle...");

  // Run tsc
  await runCommand("pnpm", ["exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")]);

  // Run rolldown
  await runCommand("npx", ["rolldown", "-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);

  writeFileSync(HASH_FILE, currentHash);
  console.log("A2UI bundle built and hash updated.");
}

async function computeHash(paths: string[]): Promise<string> {
  const files: string[] = [];

  async function walk(entryPath: string) {
    const st = await fs.stat(entryPath);
    if (st.isDirectory()) {
      const entries = await fs.readdir(entryPath);
      for (const entry of entries) {
        await walk(path.join(entryPath, entry));
      }
    } else {
      files.push(entryPath);
    }
  }

  for (const p of paths) {
    await walk(p);
  }

  // Sort files for consistent hashing
  files.sort((a, b) => {
    const na = path.relative(ROOT_DIR, a).replace(/\\/g, "/");
    const nb = path.relative(ROOT_DIR, b).replace(/\\/g, "/");
    return na.localeCompare(nb);
  });

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    const content = await fs.readFile(filePath);
    hash.update(content);
    hash.update("\0");
  }

  return hash.digest("hex");
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? `${command}.cmd` : command;
    const child = spawn(cmd, args, { stdio: "inherit", cwd: ROOT_DIR });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command ${command} ${args.join(" ")} failed with code ${code}`));
      }
    });
    child.on("error", (err) => {
      // Fallback for non-cmd on windows or validation
      if (process.platform === "win32" && err.message.includes("ENOENT")) {
        const child2 = spawn(command, args, { stdio: "inherit", cwd: ROOT_DIR });
        child2.on("close", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Command ${command} failed with code ${code}`));
          }
        });
        child2.on("error", (err2) => reject(err2));
        return;
      }
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
