import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

const exists = async (p: string) => fs.access(p).then(() => true).catch(() => false);

// 检查源码目录
const rendererExists = await exists(A2UI_RENDERER_DIR);
const appExists = await exists(A2UI_APP_DIR);

if (!rendererExists || !appExists) {
  if (await exists(OUTPUT_FILE)) {
    console.log("A2UI sources missing; keeping prebuilt bundle.");
    process.exit(0);
  }
  console.error(`A2UI sources missing and no prebuilt bundle found at: ${OUTPUT_FILE}`);
  process.exit(1);
}

// 计算哈希
async function walk(entryPath: string): Promise<string[]> {
  const st = await fs.stat(entryPath);
  if (st.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    const results = await Promise.all(entries.map(e => walk(path.join(entryPath, e))));
    return results.flat();
  }
  return [entryPath];
}

const normalize = (p: string) => p.split(path.sep).join("/");

const inputPaths = [
  path.join(ROOT_DIR, "package.json"),
  path.join(ROOT_DIR, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

const allFiles = (await Promise.all(inputPaths.map(walk))).flat();
allFiles.sort((a, b) => normalize(a).localeCompare(normalize(b)));

const hash = createHash("sha256");
for (const filePath of allFiles) {
  const rel = normalize(path.relative(ROOT_DIR, filePath));
  hash.update(rel);
  hash.update("\0");
  hash.update(await fs.readFile(filePath));
  hash.update("\0");
}
const currentHash = hash.digest("hex");

// 检查是否需要重新构建
if (await exists(HASH_FILE) && await exists(OUTPUT_FILE)) {
  const previousHash = (await fs.readFile(HASH_FILE, "utf8")).trim();
  if (previousHash === currentHash) {
    console.log("A2UI bundle up to date; skipping.");
    process.exit(0);
  }
}

const exec = (cmd: string) => execSync(cmd, { stdio: "inherit", cwd: ROOT_DIR });

// 编译 TypeScript
exec(`pnpm -s exec tsc -p "${A2UI_RENDERER_DIR}/tsconfig.json"`);

// 打包
try {
  execSync("rolldown --version", { stdio: "ignore" });
  exec(`rolldown -c "${A2UI_APP_DIR}/rolldown.config.mjs"`);
} catch {
  exec(`pnpm -s dlx rolldown -c "${A2UI_APP_DIR}/rolldown.config.mjs"`);
}

// 保存哈希
await fs.writeFile(HASH_FILE, currentHash, "utf8");
console.log("A2UI bundle complete.");
