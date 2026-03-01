#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/plugin-sdk/core.js",
  "dist/plugin-sdk/core.d.ts",
  "dist/plugin-sdk/root-alias.cjs",
  "dist/plugin-sdk/compat.js",
  "dist/plugin-sdk/compat.d.ts",
  "dist/plugin-sdk/telegram.js",
  "dist/plugin-sdk/telegram.d.ts",
  "dist/plugin-sdk/discord.js",
  "dist/plugin-sdk/discord.d.ts",
  "dist/plugin-sdk/slack.js",
  "dist/plugin-sdk/slack.d.ts",
  "dist/plugin-sdk/signal.js",
  "dist/plugin-sdk/signal.d.ts",
  "dist/plugin-sdk/imessage.js",
  "dist/plugin-sdk/imessage.d.ts",
  "dist/plugin-sdk/whatsapp.js",
  "dist/plugin-sdk/whatsapp.d.ts",
  "dist/plugin-sdk/line.js",
  "dist/plugin-sdk/line.d.ts",
  "dist/plugin-sdk/msteams.js",
  "dist/plugin-sdk/msteams.d.ts",
  "dist/plugin-sdk/acpx.js",
  "dist/plugin-sdk/acpx.d.ts",
  "dist/plugin-sdk/bluebubbles.js",
  "dist/plugin-sdk/bluebubbles.d.ts",
  "dist/plugin-sdk/copilot-proxy.js",
  "dist/plugin-sdk/copilot-proxy.d.ts",
  "dist/plugin-sdk/device-pair.js",
  "dist/plugin-sdk/device-pair.d.ts",
  "dist/plugin-sdk/diagnostics-otel.js",
  "dist/plugin-sdk/diagnostics-otel.d.ts",
  "dist/plugin-sdk/diffs.js",
  "dist/plugin-sdk/diffs.d.ts",
  "dist/plugin-sdk/feishu.js",
  "dist/plugin-sdk/feishu.d.ts",
  "dist/plugin-sdk/google-gemini-cli-auth.js",
  "dist/plugin-sdk/google-gemini-cli-auth.d.ts",
  "dist/plugin-sdk/googlechat.js",
  "dist/plugin-sdk/googlechat.d.ts",
  "dist/plugin-sdk/irc.js",
  "dist/plugin-sdk/irc.d.ts",
  "dist/plugin-sdk/llm-task.js",
  "dist/plugin-sdk/llm-task.d.ts",
  "dist/plugin-sdk/lobster.js",
  "dist/plugin-sdk/lobster.d.ts",
  "dist/plugin-sdk/matrix.js",
  "dist/plugin-sdk/matrix.d.ts",
  "dist/plugin-sdk/mattermost.js",
  "dist/plugin-sdk/mattermost.d.ts",
  "dist/plugin-sdk/memory-core.js",
  "dist/plugin-sdk/memory-core.d.ts",
  "dist/plugin-sdk/memory-lancedb.js",
  "dist/plugin-sdk/memory-lancedb.d.ts",
  "dist/plugin-sdk/minimax-portal-auth.js",
  "dist/plugin-sdk/minimax-portal-auth.d.ts",
  "dist/plugin-sdk/nextcloud-talk.js",
  "dist/plugin-sdk/nextcloud-talk.d.ts",
  "dist/plugin-sdk/nostr.js",
  "dist/plugin-sdk/nostr.d.ts",
  "dist/plugin-sdk/open-prose.js",
  "dist/plugin-sdk/open-prose.d.ts",
  "dist/plugin-sdk/phone-control.js",
  "dist/plugin-sdk/phone-control.d.ts",
  "dist/plugin-sdk/qwen-portal-auth.js",
  "dist/plugin-sdk/qwen-portal-auth.d.ts",
  "dist/plugin-sdk/synology-chat.js",
  "dist/plugin-sdk/synology-chat.d.ts",
  "dist/plugin-sdk/talk-voice.js",
  "dist/plugin-sdk/talk-voice.d.ts",
  "dist/plugin-sdk/test-utils.js",
  "dist/plugin-sdk/test-utils.d.ts",
  "dist/plugin-sdk/thread-ownership.js",
  "dist/plugin-sdk/thread-ownership.d.ts",
  "dist/plugin-sdk/tlon.js",
  "dist/plugin-sdk/tlon.d.ts",
  "dist/plugin-sdk/twitch.js",
  "dist/plugin-sdk/twitch.d.ts",
  "dist/plugin-sdk/voice-call.js",
  "dist/plugin-sdk/voice-call.d.ts",
  "dist/plugin-sdk/zalo.js",
  "dist/plugin-sdk/zalo.d.ts",
  "dist/plugin-sdk/zalouser.js",
  "dist/plugin-sdk/zalouser.d.ts",
  "dist/plugin-sdk/account-id.js",
  "dist/plugin-sdk/account-id.d.ts",
  "dist/plugin-sdk/keyed-async-queue.js",
  "dist/plugin-sdk/keyed-async-queue.d.ts",
  "dist/build-info.json",
];
const forbiddenPrefixes = ["dist/OpenClaw.app/"];

type PackageJson = {
  name?: string;
  version?: string;
};

function normalizePluginSyncVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  const base = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(normalized)?.[1];
  if (base) {
    return base;
  }
  return normalized.replace(/[-+].*$/, "");
}

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  const targetBaseVersion = targetVersion ? normalizePluginSyncVersion(targetVersion) : null;

  if (!targetVersion || !targetBaseVersion) {
    console.error("release-check: root package.json missing version.");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (normalizePluginSyncVersion(pkg.version) !== targetBaseVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    console.error(
      `release-check: plugin versions must match release base ${targetBaseVersion} (root ${targetVersion}):`,
    );
    for (const item of mismatches) {
      console.error(`  - ${item}`);
    }
    console.error("release-check: run `pnpm plugins:sync` to align plugin versions.");
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted();
  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

main();
