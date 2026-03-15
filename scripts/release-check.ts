#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectBundledExtensionManifestErrors,
  normalizeBundledExtensionMetadata,
  type BundledExtension,
  type ExtensionPackageJson as PackageJson,
} from "./lib/bundled-extension-manifest.ts";
import { sparkleBuildFloorsFromShortVersion, type SparkleBuildFloors } from "./sparkle-build.ts";

export { collectBundledExtensionManifestErrors } from "./lib/bundled-extension-manifest.ts";

type PackFile = { path: string };
type PackResult = { files?: PackFile[]; filename?: string; unpackedSize?: number };

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
// 2026.3.12 ballooned to ~213.6 MiB unpacked and correlated with low-memory
// startup/doctor OOM reports. Keep enough headroom for the current pack while
// failing fast if duplicate/shim content sneaks back into the release artifact.
const npmPackUnpackedSizeBudgetBytes = 160 * 1024 * 1024;
const appcastPath = resolve("appcast.xml");
const laneBuildMin = 1_000_000_000;
const laneFloorAdoptionDateKey = 20260227;

function normalizePluginSyncVersion(version: string): string {
  const normalized = version.trim().replace(/^v/, "");
  const base = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(normalized)?.[1];
  if (base) {
    return base;
  }
  return normalized.replace(/[-+].*$/, "");
}

export function collectBundledExtensionRootDependencyGapErrors(params: {
  rootPackage: PackageJson;
  extensions: BundledExtension[];
}): string[] {
  const rootDeps = {
    ...params.rootPackage.dependencies,
    ...params.rootPackage.optionalDependencies,
  };
  const errors: string[] = [];

  for (const extension of normalizeBundledExtensionMetadata(params.extensions)) {
    if (!extension.npmSpec) {
      continue;
    }

    const missing = Object.keys(extension.packageJson.dependencies ?? {})
      .filter((dep) => dep !== "openclaw" && !rootDeps[dep])
      .toSorted();
    const allowlisted = extension.rootDependencyMirrorAllowlist.toSorted();
    if (missing.join("\n") !== allowlisted.join("\n")) {
      const unexpected = missing.filter((dep) => !allowlisted.includes(dep));
      const resolved = allowlisted.filter((dep) => !missing.includes(dep));
      const parts = [
        `bundled extension '${extension.id}' root dependency mirror drift`,
        `missing in root package: ${missing.length > 0 ? missing.join(", ") : "(none)"}`,
      ];
      if (unexpected.length > 0) {
        parts.push(`new gaps: ${unexpected.join(", ")}`);
      }
      if (resolved.length > 0) {
        parts.push(`remove stale allowlist entries: ${resolved.join(", ")}`);
      }
      errors.push(parts.join(" | "));
    }
  }

  return errors;
}

function collectBundledExtensions(): BundledExtension[] {
  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  return entries.flatMap((entry) => {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    try {
      return [
        {
          id: entry.name,
          packageJson: JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson,
        },
      ];
    } catch {
      return [];
    }
  });
}

function checkBundledExtensionRootDependencyMirrors() {
  const rootPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as PackageJson;
  const extensions = collectBundledExtensions();
  const manifestErrors = collectBundledExtensionManifestErrors(extensions);
  if (manifestErrors.length > 0) {
    console.error("release-check: bundled extension manifest validation failed:");
    for (const error of manifestErrors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
  const errors = collectBundledExtensionRootDependencyGapErrors({
    rootPackage,
    extensions,
  });
  if (errors.length > 0) {
    console.error("release-check: bundled extension root dependency mirror validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

export function collectForbiddenPackPaths(paths: Iterable<string>): string[] {
  return [...paths]
    .filter(
      (path) =>
        forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
        /(^|\/)node_modules\//.test(path),
    )
    .toSorted();
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function resolvePackResultLabel(entry: PackResult, index: number): string {
  return entry.filename?.trim() || `pack result #${index + 1}`;
}

function formatPackUnpackedSizeBudgetError(params: {
  label: string;
  unpackedSize: number;
}): string {
  return [
    `${params.label} unpackedSize ${params.unpackedSize} bytes (${formatMiB(params.unpackedSize)}) exceeds budget ${npmPackUnpackedSizeBudgetBytes} bytes (${formatMiB(npmPackUnpackedSizeBudgetBytes)}).`,
    "Investigate duplicate channel shims, copied extension trees, or other accidental pack bloat before release.",
  ].join(" ");
}

export function collectPackUnpackedSizeErrors(results: Iterable<PackResult>): string[] {
  const entries = Array.from(results);
  const errors: string[] = [];
  let checkedCount = 0;

  for (const [index, entry] of entries.entries()) {
    if (typeof entry.unpackedSize !== "number" || !Number.isFinite(entry.unpackedSize)) {
      continue;
    }
    checkedCount += 1;
    if (entry.unpackedSize <= npmPackUnpackedSizeBudgetBytes) {
      continue;
    }
    const label = resolvePackResultLabel(entry, index);
    errors.push(formatPackUnpackedSizeBudgetError({ label, unpackedSize: entry.unpackedSize }));
  }

  if (entries.length > 0 && checkedCount === 0) {
    errors.push(
      "npm pack --dry-run produced no unpackedSize data; pack size budget was not verified.",
    );
  }

  return errors;
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

function extractTag(item: string, tag: string): string | null {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`<${escapedTag}>([^<]+)</${escapedTag}>`);
  return regex.exec(item)?.[1]?.trim() ?? null;
}

export function collectAppcastSparkleVersionErrors(xml: string): string[] {
  const itemMatches = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  const errors: string[] = [];
  const calverItems: Array<{ title: string; sparkleBuild: number; floors: SparkleBuildFloors }> =
    [];

  if (itemMatches.length === 0) {
    errors.push("appcast.xml contains no <item> entries.");
  }

  for (const [, item] of itemMatches) {
    const title = extractTag(item, "title") ?? "unknown";
    const shortVersion = extractTag(item, "sparkle:shortVersionString");
    const sparkleVersion = extractTag(item, "sparkle:version");

    if (!sparkleVersion) {
      errors.push(`appcast item '${title}' is missing sparkle:version.`);
      continue;
    }
    if (!/^[0-9]+$/.test(sparkleVersion)) {
      errors.push(`appcast item '${title}' has non-numeric sparkle:version '${sparkleVersion}'.`);
      continue;
    }

    if (!shortVersion) {
      continue;
    }
    const floors = sparkleBuildFloorsFromShortVersion(shortVersion);
    if (floors === null) {
      continue;
    }

    calverItems.push({ title, sparkleBuild: Number(sparkleVersion), floors });
  }

  const observedLaneAdoptionDateKey = calverItems
    .filter((item) => item.sparkleBuild >= laneBuildMin)
    .map((item) => item.floors.dateKey)
    .toSorted((a, b) => a - b)[0];
  const effectiveLaneAdoptionDateKey =
    typeof observedLaneAdoptionDateKey === "number"
      ? Math.min(observedLaneAdoptionDateKey, laneFloorAdoptionDateKey)
      : laneFloorAdoptionDateKey;

  for (const item of calverItems) {
    const expectLaneFloor =
      item.sparkleBuild >= laneBuildMin || item.floors.dateKey >= effectiveLaneAdoptionDateKey;
    const floor = expectLaneFloor ? item.floors.laneFloor : item.floors.legacyFloor;
    if (item.sparkleBuild < floor) {
      const floorLabel = expectLaneFloor ? "lane floor" : "legacy floor";
      errors.push(
        `appcast item '${item.title}' has sparkle:version ${item.sparkleBuild} below ${floorLabel} ${floor}.`,
      );
    }
  }

  return errors;
}

function checkAppcastSparkleVersions() {
  const xml = readFileSync(appcastPath, "utf8");
  const errors = collectAppcastSparkleVersionErrors(xml);
  if (errors.length > 0) {
    console.error("release-check: appcast sparkle version validation failed:");
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }
}

// Critical functions that channel extension plugins import from openclaw/plugin-sdk.
// If any are missing from the compiled output, plugins crash at runtime (#27569).
const requiredPluginSdkExports = [
  "isDangerousNameMatchingEnabled",
  "createAccountListHelpers",
  "buildAgentMediaPayload",
  "createReplyPrefixOptions",
  "createTypingCallbacks",
  "logInboundDrop",
  "logTypingFailure",
  "buildPendingHistoryContextFromMap",
  "clearHistoryEntriesIfEnabled",
  "recordPendingHistoryEntryIfEnabled",
  "resolveControlCommandGate",
  "resolveDmGroupAccessWithLists",
  "resolveAllowlistProviderRuntimeGroupPolicy",
  "resolveDefaultGroupPolicy",
  "resolveChannelMediaMaxBytes",
  "warnMissingProviderGroupPolicyFallbackOnce",
  "emptyPluginConfigSchema",
  "normalizePluginHttpPath",
  "registerPluginHttpRoute",
  "DEFAULT_ACCOUNT_ID",
  "DEFAULT_GROUP_HISTORY_LIMIT",
];

function checkPluginSdkExports() {
  const distPath = resolve("dist", "plugin-sdk", "index.js");
  let content: string;
  try {
    content = readFileSync(distPath, "utf8");
  } catch {
    console.error("release-check: dist/plugin-sdk/index.js not found (build missing?).");
    process.exit(1);
    return;
  }

  const exportMatch = content.match(/export\s*\{([^}]+)\}\s*;?\s*$/);
  if (!exportMatch) {
    console.error("release-check: could not find export statement in dist/plugin-sdk/index.js.");
    process.exit(1);
    return;
  }

  const exportedNames = new Set(
    exportMatch[1].split(",").map((s) => {
      const parts = s.trim().split(/\s+as\s+/);
      return (parts[parts.length - 1] || "").trim();
    }),
  );

  const missingExports = requiredPluginSdkExports.filter((name) => !exportedNames.has(name));
  if (missingExports.length > 0) {
    console.error("release-check: missing critical plugin-sdk exports (#27569):");
    for (const name of missingExports) {
      console.error(`  - ${name}`);
    }
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();
  checkAppcastSparkleVersions();
  checkPluginSdkExports();
  checkBundledExtensionRootDependencyMirrors();

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
  const forbidden = collectForbiddenPackPaths(paths);
  const sizeErrors = collectPackUnpackedSizeErrors(results);

  if (missing.length > 0 || forbidden.length > 0 || sizeErrors.length > 0) {
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
    if (sizeErrors.length > 0) {
      console.error("release-check: npm pack unpacked size budget exceeded:");
      for (const error of sizeErrors) {
        console.error(`  - ${error}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
