#!/usr/bin/env node
/**
 * npm publish readiness checklist — read-only unless --verify runs dry-runs.
 *
 * Usage:
 *   pnpm claworks:npm-publish-checklist
 *   pnpm claworks:npm-publish-checklist --verify
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    verify: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/claworks-npm-publish-checklist.mjs [--verify]

  --verify   Run publish dry-run + release preflight subset (no npm upload)
`);
  process.exit(0);
}

function readVersion(pkgPath) {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  return pkg.version ?? "(unknown)";
}

function mark(ok, label, detail = "") {
  console.log(`${ok ? "[✓]" : "[!]"} ${label}${detail ? ` — ${detail}` : ""}`);
}

console.log("ClaWorks npm 发布检查清单");
console.log("文档：docs/claworks/npm-publish.md\n");

const runtimePkg = join(root, "packages/claworks-runtime/package.json");
const rootPkg = join(root, "package.json");

console.log("── 包版本 ──");
mark(existsSync(runtimePkg), "@claworks/runtime", readVersion(runtimePkg));
mark(existsSync(rootPkg), "claworks (root CLI)", readVersion(rootPkg));

console.log("\n── 自动化预检（维护者本地）──");
console.log("[ ] pnpm claworks:runtime:publish:dry-run");
console.log("[ ] pnpm claworks:publish:dry-run");
console.log("[ ] pnpm claworks:release:preflight");

console.log("\n── 人工阻塞项 ──");
console.log("[ ] npm org @claworks 所有权 + CI publish token");
console.log("[ ] LICENSE-COMMERCIAL.md 商业签收");
console.log("[ ] CHANGELOG / release notes 维护者 landing");
console.log("[ ] 首次 beta: npm publish --access public --tag beta");

if (values.verify) {
  console.log("\n── --verify 运行中 ──");
  try {
    execSync("pnpm claworks:runtime:publish:dry-run", { cwd: root, stdio: "inherit" });
    execSync("pnpm claworks:publish:dry-run", { cwd: root, stdio: "inherit" });
    console.log(
      "\n[claworks:npm-publish-checklist] dry-run OK — upload still blocked until org approval",
    );
  } catch (err) {
    console.error("\n[claworks:npm-publish-checklist] verify failed");
    process.exit(1);
  }
} else {
  console.log("\n运行 dry-run：pnpm claworks:npm-publish-checklist --verify");
}
