#!/usr/bin/env node
/**
 * Release preflight — run before tagging / npm publish for ClaWorks.
 *
 * Usage:
 *   pnpm claworks:release:preflight
 *   CLAWORKS_SKIP_SMOKE=1 pnpm claworks:release:preflight   # skip smoke (~2 min)
 *   pnpm claworks:release:preflight -- --skip-smoke
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipSmoke =
  process.env.CLAWORKS_SKIP_SMOKE === "1" || process.argv.includes("--skip-smoke");

/** @type {Array<{ id: string; label: string; cmd?: string; skip?: boolean; hint: string; run?: () => void }>} */
const STEPS = [
  {
    id: "version",
    label: "CLI version",
    cmd: "node claworks.mjs --version",
    hint: "确认 package.json 版本与待发布 tag 一致；必要时 bump 后 rebuild。",
  },
  {
    id: "smoke",
    label: "product smoke",
    cmd: "pnpm claworks:smoke",
    skip: skipSmoke,
    hint: "修复 smoke 失败项；加速预检可设 CLAWORKS_SKIP_SMOKE=1（打 tag 前仍须全量 smoke）。",
  },
  {
    id: "gateway-e2e",
    label: "gateway e2e",
    cmd: "pnpm claworks:gateway:e2e",
    hint: "本地 Gateway 闭环失败时查 scripts/claworks-gateway-e2e.mjs 日志；确认 18800 未被占用。",
  },
  {
    id: "ot-dry-run",
    label: "OT connector dry-run",
    cmd: "pnpm claworks:ot-dry-run",
    hint: "OT 模拟连接器失败见 extensions/claworks-robot；实机签收另跑 ot-live。",
  },
  {
    id: "ot-live-checklist",
    label: "OT live checklist (read-only)",
    cmd: "pnpm claworks:ot-live-checklist",
    hint: "只读清单本身应始终通过；实机项见 docs/claworks/ot-live.md。",
  },
  {
    id: "publish-dry-run",
    label: "root npm pack dry-run",
    cmd: "pnpm claworks:publish:dry-run",
    hint: "检查 claworks 根包 tarball 内容与 bin；见 docs/claworks/npm-publish.md。",
  },
  {
    id: "runtime-publish-dry-run",
    label: "@claworks/runtime npm pack dry-run",
    cmd: "pnpm claworks:runtime:publish:dry-run",
    hint: "检查 @claworks/runtime exports/dist；先 pnpm claworks:runtime:build。",
  },
];

/** @type {Array<{ id: string; label: string; ok: boolean; skipped?: boolean; error?: string }>} */
const results = [];

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CLAWORKS_PRODUCT: process.env.CLAWORKS_PRODUCT ?? "1" },
  });
}

console.log("ClaWorks release preflight");
console.log(`repo: ${root}`);
if (skipSmoke) {
  console.log("[preflight] smoke skipped (CLAWORKS_SKIP_SMOKE=1 or --skip-smoke)");
}

for (const step of STEPS) {
  if (step.skip) {
    console.log(`\n⏭️  skip ${step.label} (${step.id})`);
    results.push({ id: step.id, label: step.label, ok: true, skipped: true });
    continue;
  }

  process.stdout.write(`\n── ${step.label} ──\n`);
  try {
    if (step.cmd) {
      run(step.cmd);
    } else if (step.run) {
      step.run();
    }
    console.log(`✅ ${step.label}`);
    results.push({ id: step.id, label: step.label, ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${step.label}: ${message}`);
    results.push({ id: step.id, label: step.label, ok: false, error: message });
  }
}

console.log("\n══════════════════════════════════════");
console.log("Preflight summary");
console.log("══════════════════════════════════════");
for (const r of results) {
  const mark = r.skipped ? "⏭️ " : r.ok ? "✅" : "❌";
  const suffix = r.skipped ? " (skipped)" : "";
  console.log(`${mark} ${r.label}${suffix}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n[preflight] ${failed.length} check(s) failed.\n`);
  console.error("Suggested next steps:");
  for (const r of failed) {
    const step = STEPS.find((s) => s.id === r.id);
    console.error(`  • ${r.label}: ${step?.hint ?? "see logs above"}`);
  }
  console.error("\nManual steps after preflight green:");
  console.error("  • OT 实机签收: docs/claworks/ot-live.md + pnpm claworks:ot-live-checklist");
  console.error("  • npm publish: docs/claworks/npm-publish.md (maintainer approval)");
  console.error("  • Release tag: git status clean → git tag v<version>");
  process.exit(1);
}

console.log("\n[preflight] all checks passed.");
console.log("\nRemaining manual release steps:");
console.log("  1. OT 实机（若适用）: docs/claworks/ot-live.md");
console.log("  2. npm publish（maintainer）: docs/claworks/npm-publish.md");
console.log("  3. git tag v<version> + push tag");
console.log("\nDocs: docs/RELEASE-CHECKLIST.md");
