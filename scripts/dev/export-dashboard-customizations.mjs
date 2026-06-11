#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "customizations", "dashboard");
const patchPath = path.join(outDir, "openclaw-dashboard-customizations.patch");
const manifestPath = path.join(outDir, "manifest.json");

const paths = [
  "ui/index.html",
  "ui/public/sw.js",
  "ui/src/styles/agents.css",
  "ui/src/styles/kalshi-dashboard.css",
  "ui/src/styles/projects.css",
  "ui/src/styles/config-quick.test.ts",
  "ui/src/styles/layout.mobile.css",
  "ui/src/styles/layout.mobile.test.ts",
  "ui/src/styles/chat/grouped.css",
  "ui/src/styles/chat/layout.css",
  "ui/src/styles/chat/layout.test.ts",
  "ui/src/styles/chat/sidebar.css",
  "ui/src/styles/chat/tool-cards.css",
  "ui/src/styles/components.css",
  "ui/src/styles/components.test.ts",
  "ui/src/ui/chat/chat-responsive.browser.test.ts",
  "ui/src/ui/mobile-viewport.ts",
  "ui/src/ui/mobile-viewport.test.ts",
  "ui/src/ui/controllers/cron.ts",
  "ui/src/ui/controllers/cron.test.ts",
  "ui/src/ui/controllers/kalshi-dashboard.ts",
  "ui/src/ui/controllers/projects.test.ts",
  "ui/src/ui/controllers/projects.ts",
  "ui/src/ui/app-render-projects-tab.ts",
  "ui/src/ui/views/agents-room.ts",
  "ui/src/ui/views/agents-room.test.ts",
  "ui/src/ui/views/agents-workflows.ts",
  "ui/src/ui/views/agents-workflows.test.ts",
  "ui/src/ui/views/agents.test.ts",
  "ui/src/ui/views/cron.ts",
  "ui/src/ui/views/cron.test.ts",
  "ui/src/ui/views/kalshi-dashboard.ts",
  "ui/src/ui/views/kalshi-dashboard.test.ts",
  "ui/src/ui/views/pattern-lab-dashboard.ts",
  "ui/src/ui/views/pattern-lab-dashboard.test.ts",
  "ui/src/ui/views/projects.ts",
  "ui/src/ui/views/projects.test.ts",
  "src/gateway/method-scopes.ts",
  "src/gateway/protocol/index.ts",
  "src/gateway/protocol/schema/projects.ts",
  "src/gateway/protocol/schema/protocol-schemas.ts",
  "src/gateway/protocol/schema/types.ts",
  "src/gateway/server-methods-list.ts",
  "src/gateway/pattern-lab-dashboard-data.ts",
  "src/gateway/pattern-lab-dashboard-data.test.ts",
  "src/gateway/pattern-lab-discord-interactions.ts",
  "src/gateway/pattern-lab-discord-interactions.test.ts",
  "src/gateway/server-methods/kalshi-dashboard.ts",
  "src/gateway/server-methods/kalshi-dashboard.test.ts",
  "src/gateway/server-methods/ops-summary.ts",
  "src/gateway/server-methods/ops-summary.test.ts",
  "src/gateway/server-methods/pattern-lab-dashboard.ts",
  "src/gateway/server-methods/pattern-lab-dashboard.test.ts",
  "src/gateway/server-methods/projects.ts",
  "src/gateway/server-methods/projects.test.ts",
  "src/projects/store.test.ts",
  "src/projects/store.ts",
  "scripts/dev/control-ui-attention-smoke.ts",
  "scripts/dev/control-ui-freshness-smoke.ts",
  "scripts/dev/control-ui-mobile-chat-visual-smoke.ts",
  "scripts/dev/control-ui-mobile-safari-smoke.ts",
  "scripts/dev/control-ui-projects-smoke.ts",
  "scripts/dev/export-dashboard-customizations.mjs",
  "youtube-v1/scripts/youtube-v1-automation.mjs",
].toSorted();

function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    ...options,
  });
  return result;
}

function isTracked(filePath) {
  return runGit(["ls-files", "--error-unmatch", filePath]).status === 0;
}

function diffTracked(filePath) {
  const result = runGit(["diff", "--binary", "--", filePath]);
  if (result.status !== 0) {
    throw new Error(result.stderr || `git diff failed for ${filePath}`);
  }
  return result.stdout;
}

function diffUntracked(filePath) {
  const result = runGit(["diff", "--binary", "--no-index", "--", "/dev/null", filePath]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr || `git diff --no-index failed for ${filePath}`);
  }
  return result.stdout;
}

function sha256(filePath) {
  return createHash("sha256")
    .update(readFileSync(path.join(root, filePath)))
    .digest("hex");
}

const entries = [];
const patchSections = [];

for (const filePath of paths) {
  if (!existsSync(path.join(root, filePath))) {
    continue;
  }
  const tracked = isTracked(filePath);
  const patch = tracked ? diffTracked(filePath) : diffUntracked(filePath);
  if (!patch.trim()) {
    continue;
  }
  patchSections.push(patch.endsWith("\n") ? patch : `${patch}\n`);
  entries.push({
    path: filePath,
    tracked,
    bytes: readFileSync(path.join(root, filePath)).byteLength,
    sha256: sha256(filePath),
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(patchPath, patchSections.join("\n"), "utf8");
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      name: "OpenClaw Dashboard Customizations",
      generatedAtUtc: new Date().toISOString(),
      patch: path.relative(root, patchPath),
      fileCount: entries.length,
      files: entries,
      verify: [
        "git apply --check --cached customizations/dashboard/openclaw-dashboard-customizations.patch",
        "pnpm test ui/src/ui/pwa-shell.test.ts ui/src/styles/config-quick.test.ts",
        "pnpm test ui/src/styles/components.test.ts ui/src/ui/views/agents-room.test.ts ui/src/ui/views/agents.test.ts ui/src/ui/views/cron.test.ts ui/src/ui/controllers/cron.test.ts",
        "pnpm ui:build",
      ],
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Wrote ${path.relative(root, patchPath)} (${entries.length} files)`);
console.log(`Wrote ${path.relative(root, manifestPath)}`);
