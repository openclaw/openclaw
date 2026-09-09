#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isUpdateCompatibilityChunk } from "../../lib/update-compat-contract.mjs";

// Frozen candidates predating the recorded inventory retain their original fixture contract.
export const LEGACY_UPDATE_COMPAT_CHUNKS = [
  "shared-DTaQo6Hi.js",
  "shared-Y6bNiw2w.js",
  "shared-DFJEouXv.js",
];
export const FUTURE_FIXTURE_VERSION = "2026.9.99-first-hop.0";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFirstHopReleases(packageRoot) {
  const inventoryPath = path.join(packageRoot, "dist", "update-compat-inventory.json");
  if (!fs.existsSync(inventoryPath)) {
    return [];
  }
  const { releases } = readJson(inventoryPath);
  if (!Array.isArray(releases)) {
    throw new Error("package fixture compatibility inventory has no releases");
  }
  return releases;
}

export function listFirstHopSourceVersions(packageRoot) {
  const versions = readFirstHopReleases(packageRoot).map((release) => release.version);
  if (
    versions.length === 0 ||
    new Set(versions).size !== versions.length ||
    versions.some(
      (version) =>
        typeof version !== "string" || !/^\d{4}\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(version),
    )
  ) {
    throw new Error("first-hop defaults require recorded release versions in the candidate");
  }
  return versions;
}

export function inspectFirstHopSource(packageRoot, tarball, options = {}) {
  const releases = readFirstHopReleases(packageRoot);
  const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
  const release = options.version
    ? releases.find((entry) => entry.version === options.version)
    : releases.find((entry) => entry.integrity === integrity);
  if (options.version && (!release || release.integrity !== integrity)) {
    throw new Error(`first-hop source integrity mismatch for ${options.version}`);
  }
  // Verify recorded bytes before asking tar to read any package member.
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  if (releases.some((entry) => entry.version === manifest.version) && !release) {
    throw new Error(`first-hop source integrity mismatch for ${manifest.version}`);
  }
  if (
    manifest.name !== "openclaw" ||
    typeof manifest.version !== "string" ||
    (release && manifest.version !== release.version)
  ) {
    throw new Error("first-hop source package identity does not match its recorded release");
  }
  const restartChunk = release?.chunks.find((chunk) =>
    chunk.imports.some(
      (entry) =>
        entry.owner === "src/cli/update-cli/update-command-service-command.ts" &&
        entry.exports.includes("resolveNodeRunner"),
    ),
  );
  // The original lane's published baseline predates the recorded inventory.
  const legacyMissingChunk =
    !release && manifest.version === "2026.8.2" ? "shared-Y6bNiw2w.js" : undefined;
  const expectedMissingChunk =
    options.expectedMissingChunk ?? restartChunk?.path ?? legacyMissingChunk ?? null;
  if (!release && !expectedMissingChunk) {
    throw new Error("unrecorded first-hop source requires an explicit expected missing chunk");
  }
  return {
    version: manifest.version,
    integrity,
    recorded: Boolean(release),
    expectedMissingChunk,
    negativeControl: expectedMissingChunk
      ? { status: "required", missingChunk: expectedMissingChunk }
      : {
          status: "not-applicable",
          reason: release?.chunks.length
            ? "no-recorded-lazy-service-restart-import"
            : "source-has-no-recorded-post-swap-imports",
        },
  };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFixturePaths(packageRoot) {
  const root = path.resolve(packageRoot);
  const packageJson = path.join(root, "package.json");
  const buildInfo = path.join(root, "dist", "build-info.json");
  const inventory = path.join(root, "dist", "postinstall-inventory.json");
  for (const filePath of [packageJson, buildInfo, inventory]) {
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`missing package fixture input: ${filePath}`);
    }
  }
  return { root, packageJson, buildInfo, inventory };
}

export function removeLegacyUpdateCompatChunks(packageRoot) {
  const paths = resolveFixturePaths(packageRoot);
  const inventory = readJson(paths.inventory);
  if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
    throw new Error("package fixture inventory is not a string array");
  }

  const compatibilityPath = path.join(paths.root, "dist", "update-compat-inventory.json");
  const recordedChunks = fs.existsSync(compatibilityPath)
    ? readJson(compatibilityPath).releases.flatMap((release) =>
        release.chunks.map((chunk) => chunk.path),
      )
    : [];
  if (
    recordedChunks.some(
      (name) =>
        typeof name !== "string" ||
        path.isAbsolute(name) ||
        name.includes("\\") ||
        name.split("/").includes(".."),
    )
  ) {
    throw new Error("package fixture compatibility inventory has an invalid path");
  }
  const chunks = new Set([
    ...LEGACY_UPDATE_COMPAT_CHUNKS,
    ...recordedChunks.filter((name) => {
      if (!/-[A-Za-z0-9_-]{8}\.m?js$/.test(name)) {
        return false;
      }
      return isUpdateCompatibilityChunk(
        fs.readFileSync(path.join(paths.root, "dist", name), "utf8"),
      );
    }),
  ]);
  const removed = [];
  for (const name of chunks) {
    const relativePath = `dist/${name}`;
    const filePath = path.join(paths.root, relativePath);
    if (!fs.existsSync(filePath) || !inventory.includes(relativePath)) {
      throw new Error(`package fixture is missing compatibility input: ${relativePath}`);
    }
    fs.rmSync(filePath);
    removed.push(relativePath);
  }
  writeJson(
    paths.inventory,
    inventory.filter((entry) => !removed.includes(entry)),
  );
}

function futureFixtureVersion(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 9) {
    throw new Error("future fixture sequence must be an integer from 0 to 9");
  }
  return FUTURE_FIXTURE_VERSION.replace(/0$/, String(sequence));
}

function stampFixtureVersion(packageRoot, version) {
  const paths = resolveFixturePaths(packageRoot);
  const packageJson = readJson(paths.packageJson);
  const buildInfo = readJson(paths.buildInfo);
  packageJson.version = version;
  buildInfo.version = version;
  // The unchanged compiled UI still carries the prepared artifact's opaque build ID.
  writeJson(paths.packageJson, packageJson);
  writeJson(paths.buildInfo, buildInfo);
}

export function markFutureUpdateFixture(packageRoot, sequence = 0) {
  const version = futureFixtureVersion(sequence);
  removeLegacyUpdateCompatChunks(packageRoot);
  stampFixtureVersion(packageRoot, version);
}

function packageMembers(root) {
  const members = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else {
        const bytes = entry.isSymbolicLink()
          ? `link:${fs.readlinkSync(file)}`
          : fs.readFileSync(file);
        members.set(
          path.relative(root, file).split(path.sep).join("/"),
          createHash("sha256").update(bytes).digest("hex"),
        );
      }
    }
  };
  visit(root);
  return new Map([...members].toSorted(([left], [right]) => left.localeCompare(right)));
}

function packTransformedFixture(candidateTarball, outputTarball, transform) {
  const source = path.resolve(candidateTarball);
  const output = path.resolve(outputTarball);
  if (source === output || fs.existsSync(output)) {
    throw new Error("future fixture output must be a new tarball path");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-future-update-"));
  try {
    execFileSync("tar", ["-xzf", source, "-C", root]);
    const packageRoot = path.join(root, "package");
    const sourceVersion = readJson(path.join(packageRoot, "package.json")).version;
    const before = packageMembers(packageRoot);
    transform(packageRoot);
    const after = packageMembers(packageRoot);
    execFileSync("tar", ["-czf", output, "-C", root, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return {
      sourceVersion,
      targetVersion: readJson(path.join(packageRoot, "package.json")).version,
      sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
      targetSha256: createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
      members: {
        sourceSha256: createHash("sha256")
          .update(JSON.stringify([...before]))
          .digest("hex"),
        targetSha256: createHash("sha256")
          .update(JSON.stringify([...after]))
          .digest("hex"),
        changes: [...new Set([...before.keys(), ...after.keys()])]
          .toSorted((left, right) => left.localeCompare(right))
          .filter((name) => before.get(name) !== after.get(name))
          .map((name) => ({
            path: name,
            before: before.get(name) ?? null,
            after: after.get(name) ?? null,
          })),
      },
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function packFirstHopUpdateFixture(candidateTarball, outputTarball, sequence = 0) {
  const version = futureFixtureVersion(sequence);
  return {
    method: "candidate-same-schema-first-hop-fixture",
    ...packTransformedFixture(candidateTarball, outputTarball, (root) => {
      stampFixtureVersion(root, version);
    }),
  };
}

function packNegativeUpdateFixture(candidateTarball, outputTarball) {
  return {
    method: "candidate-missing-compatibility-fixture",
    ...packTransformedFixture(candidateTarball, outputTarball, removeLegacyUpdateCompatChunks),
  };
}

export function packFutureUpdateFixture(candidateTarball, outputTarball, sequence = 0) {
  return {
    method: "candidate-same-schema-self-update-fixture",
    ...packTransformedFixture(candidateTarball, outputTarball, (root) => {
      markFutureUpdateFixture(root, sequence);
    }),
  };
}

function packFutureRuntimeFixture(candidateTarball, outputTarball, sequence = 0) {
  const version = futureFixtureVersion(sequence);
  return {
    method: "candidate-same-schema-runtime-fixture",
    name: "@openclaw/codex",
    ...packTransformedFixture(candidateTarball, outputTarball, (root) => {
      const manifestPath = path.join(root, "package.json");
      const manifest = readJson(manifestPath);
      if (manifest.name !== "@openclaw/codex") {
        throw new Error("future runtime fixture requires the @openclaw/codex package");
      }
      if (
        typeof manifest.version !== "string" ||
        !/^\d{4}\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/iu.test(
          manifest.version,
        ) ||
        manifest.openclaw?.build?.openclawVersion !== manifest.version
      ) {
        throw new Error("runtime package version and OpenClaw build cohort must match");
      }
      manifest.version = version;
      manifest.openclaw.build.openclawVersion = version;
      writeJson(manifestPath, manifest);
    }),
  };
}

function main() {
  const [mode, packageRoot, outputTarball, sequence] = process.argv.slice(2);
  if (mode === "sources" && packageRoot) {
    process.stdout.write(`${listFirstHopSourceVersions(packageRoot).join("\n")}\n`);
    return;
  }
  if (mode === "source" && packageRoot && outputTarball) {
    process.stdout.write(
      `${JSON.stringify(
        inspectFirstHopSource(packageRoot, outputTarball, {
          version: sequence || undefined,
          expectedMissingChunk: sequence
            ? undefined
            : process.env.OPENCLAW_UPDATE_FIRST_HOP_EXPECTED_MISSING_CHUNK,
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (
    (mode === "first-hop-tarball" ||
      mode === "negative-tarball" ||
      mode === "future-tarball" ||
      mode === "future-runtime-tarball") &&
    packageRoot &&
    outputTarball
  ) {
    const pack = {
      "first-hop-tarball": packFirstHopUpdateFixture,
      "negative-tarball": packNegativeUpdateFixture,
      "future-tarball": packFutureUpdateFixture,
      "future-runtime-tarball": packFutureRuntimeFixture,
    }[mode];
    process.stdout.write(
      `${JSON.stringify(pack(packageRoot, outputTarball, sequence === undefined ? 0 : Number(sequence)), null, 2)}\n`,
    );
    return;
  }
  if (!packageRoot || (mode !== "negative" && mode !== "future")) {
    throw new Error(
      "usage: update-first-hop-package-fixtures.mjs <negative|future> <package-root> OR <first-hop-tarball|negative-tarball|future-tarball|future-runtime-tarball> <source.tgz> <new-output.tgz> [sequence0–9]",
    );
  }
  if (mode === "negative") {
    removeLegacyUpdateCompatChunks(packageRoot);
  } else {
    markFutureUpdateFixture(packageRoot);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
