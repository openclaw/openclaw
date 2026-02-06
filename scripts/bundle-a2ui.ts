import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

const INPUT_PATHS = [
  path.join(ROOT_DIR, "package.json"),
  path.join(ROOT_DIR, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

async function walk(entryPath: string, files: string[]) {
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(entryPath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (st.isDirectory()) {
    let entries: string[];
    try {
      entries = await fs.readdir(entryPath);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      await walk(path.join(entryPath, entry), files);
    }
  } else {
    files.push(entryPath);
  }
}

function normalize(p: string) {
  return p.split(path.sep).join("/");
}

async function computeHash() {
  const files: string[] = [];
  for (const input of INPUT_PATHS) {
    await walk(input, files);
  }

  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    const content = await fs.readFile(filePath);
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const resolvedCommand =
      process.platform === "win32" && !command.endsWith(".cmd") ? `${command}.cmd` : command;
    const child = spawn(resolvedCommand, args, {
      cwd: ROOT_DIR,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command failed: ${command} ${args.join(" ")}`));
      }
    });
  });
}

async function main() {
  try {
    await fs.access(A2UI_RENDERER_DIR);
    await fs.access(A2UI_APP_DIR);
  } catch {
    console.log("A2UI sources missing; keeping prebuilt bundle.");
    return;
  }

  const currentHash = await computeHash();
  let previousHash = "";
  try {
    previousHash = (await fs.readFile(HASH_FILE, "utf-8")).trim();
  } catch {}

  if (previousHash === currentHash) {
    try {
      await fs.access(OUTPUT_FILE);
      console.log("A2UI bundle up to date; skipping.");
      return;
    } catch {}
  }

  try {
    await run("pnpm", ["-s", "exec", "tsc", "-p", path.join(A2UI_RENDERER_DIR, "tsconfig.json")]);
    await run("rolldown", ["-c", path.join(A2UI_APP_DIR, "rolldown.config.mjs")]);

    await fs.mkdir(path.dirname(HASH_FILE), { recursive: true });
    await fs.writeFile(HASH_FILE, currentHash);
  } catch {
    console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
    console.error("If this persists, verify pnpm deps and try again.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
