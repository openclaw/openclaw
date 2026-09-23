#!/usr/bin/env node

// Temporarily narrows CHANGELOG.md to packaged release notes for npm tarballs.
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findChangelogSection, findReleaseChangelog } from "./lib/release-changelog.mjs";
import { compactReleaseNotes } from "./lib/release-notes-compaction.mjs";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_JSON_PATH = "package.json";
const BACKUP_PATH = path.join(".artifacts", "package-changelog", "CHANGELOG.md.prepack-backup");
const PACKAGED_BACKUP_PATH = path.join(".artifacts", "package-changelog", "CHANGELOG.md.packaged");
const MAX_PACKAGED_CHANGELOG_BYTES = 500 * 1024;
const MIN_RELEASE_SECTION_BODY_BYTES = 32;
const UNRELEASED_HEADING = "Unreleased";
const RELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?$/u;
const PRERELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)-(?:alpha|beta)\.[1-9][0-9]*$/u;

/**
 * Resolves acceptable changelog headings for a package version.
 */
export function resolvePackageChangelogVersions(packageVersion, options = {}) {
  const match = RELEASE_VERSION_PATTERN.exec(packageVersion);
  if (!match) {
    throw new Error(
      `Unsupported OpenClaw package version for changelog packaging: ${packageVersion}`,
    );
  }
  if (PRERELEASE_VERSION_PATTERN.test(packageVersion)) {
    return [packageVersion, match[1], UNRELEASED_HEADING];
  }
  return options.allowUnreleased ? [packageVersion, UNRELEASED_HEADING] : [packageVersion];
}

function splitLines(content) {
  return content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
}

function assertMeaningfulReleaseBody(section, version) {
  const body = section.split(/\r?\n/u).slice(1).join("\n").trim();
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes < MIN_RELEASE_SECTION_BODY_BYTES) {
    throw new Error(
      `Packaged changelog section for ${version} is only ${bodyBytes} body bytes, which is below the ${MIN_RELEASE_SECTION_BODY_BYTES} byte safety minimum.`,
    );
  }
}

/**
 * Extracts the current release changelog section for package publishing.
 */
export function extractCurrentPackageChangelog(content, packageVersion, options = {}) {
  const targetVersions = resolvePackageChangelogVersions(packageVersion, options);
  const lines = splitLines(content);
  // Keep numbered drafts exact-matchable; their marker only widens the allowed draft fallback.
  let selected;
  for (const version of targetVersions) {
    selected = findChangelogSection(lines.join("\n"), version);
    if (selected !== null) {
      break;
    }
  }
  if (!selected) {
    throw new Error(
      `CHANGELOG.md does not contain a release section for ${targetVersions.join(" or ")}.`,
    );
  }
  const firstLevelTwoHeadingIndex = lines.findIndex((line) => line.startsWith("## "));
  const preamble = lines.slice(0, firstLevelTwoHeadingIndex).join("\n").trimEnd();
  const releaseSection = selected.trimEnd();
  const selectedVersion = /^##\s+(\S+)/u.exec(releaseSection)[1];
  assertMeaningfulReleaseBody(releaseSection, selectedVersion);
  let packaged = `${preamble}\n\n${releaseSection}\n`;
  if (Buffer.byteLength(packaged, "utf8") > MAX_PACKAGED_CHANGELOG_BYTES) {
    // Keep every editorial note; only the audited record moves behind its immutable source link.
    const compacted = compactReleaseNotes(
      releaseSection,
      "openclaw/openclaw",
      `v${packageVersion}`,
      options.recordPath,
    );
    if (compacted) {
      assertMeaningfulReleaseBody(compacted.editorialNotes, selectedVersion);
      packaged = `${preamble}\n\n${compacted.body}\n`;
    }
  }
  const packagedBytes = Buffer.byteLength(packaged, "utf8");
  if (packagedBytes > MAX_PACKAGED_CHANGELOG_BYTES) {
    throw new Error(
      `Packaged changelog is ${packagedBytes} bytes, which exceeds the ${MAX_PACKAGED_CHANGELOG_BYTES} byte safety limit.`,
    );
  }
  return packaged;
}

/** Resolves the source layout before applying the package's release-selection and size policy. */
export function readCurrentPackageChangelog(rootDir, packageVersion, options = {}) {
  const targetVersions = resolvePackageChangelogVersions(packageVersion, options);
  for (const version of targetVersions) {
    const source = findReleaseChangelog({ rootDir, ref: options.ref, version });
    if (!source) {
      continue;
    }
    let content = `${source.preamble}\n\n${source.section}`;
    if (
      source.format === "docs-mirror" &&
      Buffer.byteLength(`${content.trimEnd()}\n`, "utf8") > MAX_PACKAGED_CHANGELOG_BYTES
    ) {
      content = [
        source.preamble,
        `## ${source.version}`,
        "The complete release documentation exceeds the package's 500 KiB changelog limit.",
        `Read the [full release notes](https://github.com/openclaw/openclaw/blob/main/${source.sourcePath}) ([Raw](https://github.com/openclaw/openclaw/raw/refs/heads/main/${source.sourcePath})) or the [release documentation](https://docs.openclaw.ai/releases/${source.version}).`,
        `The [complete contribution record](https://github.com/openclaw/openclaw/blob/main/${source.recordPath}#complete-contribution-record) remains available separately.`,
        "The changelog and contribution-record links follow the maintained files on main.",
      ].join("\n\n");
    }
    return extractCurrentPackageChangelog(content, packageVersion, {
      ...options,
      recordPath: source.recordPath ?? undefined,
    });
  }
  throw new Error(
    `CHANGELOG.md does not contain a release section for ${targetVersions.join(" or ")}.`,
  );
}

async function readPackageVersion(cwd) {
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  return packageJson.version;
}

/**
 * Restores the source changelog from a package-changelog backup.
 */
export async function restorePackageChangelog(cwd = process.cwd()) {
  const backupPath = path.join(cwd, BACKUP_PATH);
  const packagedBackupPath = path.join(cwd, PACKAGED_BACKUP_PATH);
  if (!existsSync(backupPath)) {
    return false;
  }
  const changelogPath = path.join(cwd, CHANGELOG_PATH);
  const [backup, current] = await Promise.all([
    readFile(backupPath, "utf8"),
    readFile(changelogPath, "utf8"),
  ]);
  if (current !== backup) {
    let expectedPackaged;
    if (existsSync(packagedBackupPath)) {
      // The split index cannot reconstruct package bytes. Retain the exact prepared
      // output so recovery also works after source notes or package versions change.
      expectedPackaged = await readFile(packagedBackupPath, "utf8");
    } else {
      // Recover backups written by the published monolithic packaging lifecycle.
      const packageVersion = await readPackageVersion(cwd);
      try {
        expectedPackaged = extractCurrentPackageChangelog(backup, packageVersion);
      } catch (error) {
        try {
          expectedPackaged = extractCurrentPackageChangelog(backup, packageVersion, {
            allowUnreleased: true,
          });
        } catch {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Refusing to restore stale packaged changelog backup from ${BACKUP_PATH}: ${message}`,
            { cause: error },
          );
        }
      }
    }
    if (current !== expectedPackaged) {
      throw new Error(
        `Refusing to restore packaged changelog backup from ${BACKUP_PATH} because CHANGELOG.md has changed since the backup was written.`,
      );
    }
  }
  await writeFile(changelogPath, backup, "utf8");
  await rm(backupPath, { force: true });
  await rm(packagedBackupPath, { force: true });
  return true;
}

/**
 * Writes packaged changelog content while preserving a restorable backup.
 */
export async function preparePackageChangelog(cwd = process.cwd(), options = {}) {
  await restorePackageChangelog(cwd);
  const changelogPath = path.join(cwd, CHANGELOG_PATH);
  const backupPath = path.join(cwd, BACKUP_PATH);
  const original = await readFile(changelogPath, "utf8");
  const packageVersion = await readPackageVersion(cwd);
  const packaged = readCurrentPackageChangelog(cwd, packageVersion, options);
  if (packaged === original) {
    return false;
  }
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(path.join(cwd, PACKAGED_BACKUP_PATH), packaged, "utf8");
  await writeFile(backupPath, original, "utf8");
  await writeFile(changelogPath, packaged, "utf8");
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "prepare") {
    const changed = await preparePackageChangelog();
    console.error(
      changed
        ? "package-changelog: wrote current release notes for package tarball."
        : "package-changelog: source changelog already matches package notes.",
    );
    return;
  }
  if (command === "restore") {
    const restored = await restorePackageChangelog();
    console.error(
      restored
        ? "package-changelog: restored source CHANGELOG.md."
        : "package-changelog: no packaged changelog backup to restore.",
    );
    return;
  }
  console.error("Usage: node scripts/package-changelog.mjs <prepare|restore>");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
