#!/usr/bin/env node
/**
 * Sync the openclaw catalog (and its tests) to a new openclaw-plugin-yuanbao
 * version. Extracted from .github/workflows/sync-catalog.yml so it can be run
 * and debugged locally without the CI pipeline.
 *
 * What it does:
 *   1. Resolve the target version (from --version or the latest npm release).
 *   2. Resolve the npm dist integrity (from --integrity, or by polling `npm view`).
 *   3. Read the catalog JSON to capture the *old* integrity currently recorded.
 *   4. Update the catalog + 5 test files: bump the version string and replace
 *      the old integrity hash with the new one. Uses string replacement so the
 *      existing file formatting is preserved.
 *
 * It operates on the CURRENT working directory (the openclaw checkout root).
 * The CI workflow checks out the openclaw repo into ./openclaw and runs this
 * script from there; locally just `cd` into your openclaw checkout first.
 *
 * Usage:
 *   # Auto-resolve version + integrity from npm:
 *   node scripts/sync-catalog.mjs
 *
 *   # Pin a version, auto-fetch its integrity from npm:
 *   node scripts/sync-catalog.mjs --version 2.17.1
 *
 *   # Pin both (skip npm entirely — useful for dry runs / offline):
 *   node scripts/sync-catalog.mjs --version 2.17.1 --integrity sha512-...
 *
 *   # Don't write anything, just print what would change:
 *   node scripts/sync-catalog.mjs --dry-run
 *
 * Exit code 1 on error (e.g. integrity not found after timeout); 0 on success.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CATALOG_PATH = "scripts/lib/official-external-channel-catalog.json";

const TEST_FILES = [
  "src/channels/plugins/catalog.test.ts",
  "src/channels/plugins/contracts/channel-catalog.contract.test.ts",
  "src/config/config.plugin-validation.test.ts",
  "src/plugins/official-external-plugin-catalog.test.ts",
  "test/official-channel-catalog.test.ts",
];

const PKG = "openclaw-plugin-yuanbao";
const VERSION_RE = /openclaw-plugin-yuanbao@\d+\.\d+\.\d+/g;
const INTEGRITY_RE = /"expectedIntegrity":\s*"(sha512-[^"]+)"/;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    version: null,
    integrity: null,
    dryRun: false,
    waitSeconds: 300,
    pollIntervalMs: 10_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--version") args.version = argv[++i];
    else if (a === "--integrity") args.integrity = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--wait") args.waitSeconds = Number(argv[++i]);
    else if (a === "--interval") args.pollIntervalMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`[sync-catalog] unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/sync-catalog.mjs [options]

Options:
  --version <ver>      Target version (without 'v' prefix). If omitted, the
                       latest version published to npm is used.
  --integrity <hash>   npm dist integrity (sha512-...). If omitted, it is
                       fetched from npm via 'npm view'.
  --dry-run             Print the planned changes without writing files.
  --wait <seconds>      Max seconds to wait for npm integrity (default 300).
  --interval <ms>        Polling interval for npm view (default 10000).
  -h, --help             Show this help.

Run from the root of an openclaw checkout.`);
}

// ---------------------------------------------------------------------------
// Version + integrity resolution
// ---------------------------------------------------------------------------

async function resolveLatestVersion() {
  // `npm view openclaw-plugin-yuanbao version` returns the latest dist-tag.
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync("npm", ["view", PKG, "version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const v = out.trim();
  if (!v) throw new Error("npm view returned empty version");
  return v;
}

async function resolveIntegrity(version, { waitSeconds, pollIntervalMs }) {
  const { execFileSync } = await import("node:child_process");
  const deadline = Date.now() + waitSeconds * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    let out = "";
    try {
      out = execFileSync("npm", ["view", `${PKG}@${version}`, "dist.integrity"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      });
    } catch {
      // npm view fails while the version isn't propagated yet — retry.
    }
    const integrity = out.trim();
    if (integrity) {
      console.log(`[sync-catalog] got integrity on attempt ${attempt}: ${integrity}`);
      return integrity;
    }
    console.log(
      `[sync-catalog] attempt ${attempt}: not yet available, waiting ${pollIntervalMs}ms...`,
    );
    await sleep(pollIntervalMs);
  }
  throw new Error(`Failed to fetch integrity for ${PKG}@${version} after ${waitSeconds}s`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Catalog + test file updates
// ---------------------------------------------------------------------------

/** Extract the currently-recorded integrity for our package from the catalog. */
function readOldIntegrity(catalogContent) {
  const idx = catalogContent.indexOf(PKG);
  if (idx === -1) return null;
  const m = catalogContent.slice(idx).match(INTEGRITY_RE);
  return m ? m[1] : null;
}

function updateFile(path, { version, oldIntegrity, newIntegrity, dryRun }) {
  if (!existsSync(path)) {
    console.warn(`[sync-catalog] skip missing file: ${path}`);
    return false;
  }
  let content = readFileSync(path, "utf8");
  const before = content;

  content = content.replace(VERSION_RE, `${PKG}@${version}`);
  if (oldIntegrity && newIntegrity && content.includes(oldIntegrity)) {
    content = content.split(oldIntegrity).join(newIntegrity); // replaceAll
  }

  if (content === before) {
    console.log(`[sync-catalog] no change: ${path}`);
    return false;
  }
  if (!dryRun) writeFileSync(path, content);
  console.log(`[sync-catalog] ${dryRun ? "would update" : "updated"}: ${path}`);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Resolve version
  let version = args.version;
  if (!version) {
    version = await resolveLatestVersion();
    console.log(`[sync-catalog] resolved latest version: ${version}`);
  }

  // Resolve integrity
  let integrity = args.integrity;
  if (!integrity) {
    integrity = await resolveIntegrity(version, {
      waitSeconds: args.waitSeconds,
      pollIntervalMs: args.pollIntervalMs,
    });
  }

  console.log(
    `[sync-catalog] syncing to ${PKG}@${version} (integrity ${integrity})${
      args.dryRun ? " [DRY RUN]" : ""
    }`,
  );

  // Make sure we're operating on a real openclaw checkout.
  if (!existsSync(CATALOG_PATH)) {
    console.error(
      `[sync-catalog] catalog not found at ./${CATALOG_PATH} — run this from an openclaw checkout root.`,
    );
    process.exit(1);
  }

  // Capture old integrity BEFORE we touch the catalog.
  const catalogContent = readFileSync(CATALOG_PATH, "utf8");
  const oldIntegrity = readOldIntegrity(catalogContent);
  if (!oldIntegrity) {
    console.warn("[sync-catalog] no existing integrity found in catalog");
  } else {
    console.log(`[sync-catalog] old integrity: ${oldIntegrity}`);
  }

  // Update catalog + tests.
  let changed = 0;
  if (
    updateFile(CATALOG_PATH, {
      version,
      oldIntegrity,
      newIntegrity: integrity,
      dryRun: args.dryRun,
    })
  )
    changed++;
  for (const f of TEST_FILES) {
    if (
      updateFile(f, {
        version,
        oldIntegrity,
        newIntegrity: integrity,
        dryRun: args.dryRun,
      })
    )
      changed++;
  }

  console.log(
    `[sync-catalog] done. ${changed} file(s) ${args.dryRun ? "would be " : ""}updated ` +
      `to ${PKG}@${version}.`,
  );
}

main().catch((e) => {
  console.error(`[sync-catalog] ${e.message?.split("\n")[0] ?? e}`);
  process.exit(1);
});
