import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function fixtureGit(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

export function readFixtureJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function writeFixtureJson(filename, value) {
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

export function readPackedFixture(tarball) {
  // Read metadata to stdout; never extract a cached package into the checkout.
  const readPacked = (file) =>
    JSON.parse(execFileSync("tar", ["-xOf", tarball, `package/${file}`], { encoding: "utf8" }));
  const manifest = readPacked("package.json");
  const build = readPacked("dist/build-info.json");
  assert.equal(manifest.name, "openclaw", "expected an OpenClaw package");
  assert.equal(build.version, manifest.version, "packed manifest/build version mismatch");
  assert(typeof build.buildId === "string" && build.buildId.trim(), "missing packed build ID");
  return { build, schemaVersions: manifest.openclaw.schemaVersions };
}

export function assertPackedSource(packed, commit, manifest, label) {
  assert.equal(packed.build.commit, commit, `${label} source commit mismatch`);
  assert.equal(packed.build.version, manifest.version, `${label} package version mismatch`);
  assert.deepEqual(
    packed.schemaVersions,
    manifest.openclaw.schemaVersions,
    `${label} package schema mismatch`,
  );
}

async function tarballDigest(tarball) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(tarball)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function readPrebuiltFixture(tarball, metadata) {
  assert.equal(await tarballDigest(tarball), metadata.sha256, `${tarball} digest mismatch`);
  const packed = readPackedFixture(tarball);
  assert.deepEqual(packed, metadata.packed, `${tarball} metadata mismatch`);
  return packed;
}

export async function buildTypedFixture({
  tree,
  tarball,
  commit,
  buildId,
  install,
  generateSchema,
  timingsMs = {},
}) {
  const env = {
    ...process.env,
    GIT_COMMIT: commit,
    OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
  };
  const run = (phase, program, args) => {
    const start = performance.now();
    execFileSync(program, args, { cwd: tree, env, stdio: "inherit" });
    timingsMs[phase] = Math.round(performance.now() - start);
  };
  if (install) {
    run("install", "pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);
  }
  if (generateSchema) {
    run("schemaGeneration", "pnpm", ["db:postgres:gen"]);
  }
  run("build", "pnpm", ["build:ci-artifacts"]);
  run("declarations", "node", [
    "--import",
    "./scripts/tsx.mjs",
    "scripts/write-unified-entry-dts.ts",
  ]);
  run("package", "node", [
    "scripts/package-openclaw-for-docker.mjs",
    "--skip-build",
    "--allow-unreleased-changelog",
    "--output-dir",
    path.dirname(tarball),
    "--output-name",
    path.basename(tarball),
  ]);
  console.log(`Fixture ${path.basename(tarball)} phase timings (ms): ${JSON.stringify(timingsMs)}`);
  const packed = readPackedFixture(tarball);
  assert.equal(packed.build.buildId, buildId, "fixture package has the wrong build ID");
  return { packed, sha256: await tarballDigest(tarball) };
}

export async function withArchivedFixture(repo, commit, directory, name, build) {
  const tree = path.join(directory, name);
  const archive = `${tree}.tar`;
  fs.mkdirSync(tree);
  try {
    execFileSync("git", ["archive", "--output", archive, commit], { cwd: repo });
    execFileSync("tar", ["-xf", archive, "-C", tree]);
    fs.unlinkSync(archive);
    await build(tree);
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
}
