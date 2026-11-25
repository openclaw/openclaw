// The previous reader is the real fork point, not a relabeled candidate package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function needsSchemaDowngrade(before, after, changedPaths) {
  if (
    ["state", "agent"].some(
      (store) => before.openclaw.schemaVersions[store] !== after.openclaw.schemaVersions[store],
    )
  ) {
    return true;
  }
  return changedPaths.some(
    (file) =>
      /^(?:src\/state\/|src\/infra\/database-engine\/|packages\/memory-host-sdk\/)/u.test(file) &&
      !/\.(?:test|test-support|test-harness)\.[cm]?[jt]s$/u.test(file) &&
      /(?:schema|migration|maintenance)/iu.test(file) &&
      /\.(?:[cm]?[jt]s|sql)$/u.test(file),
  );
}
export function readPackedJson(tarball, file) {
  return JSON.parse(
    execFileSync("tar", ["-xOf", tarball, `package/${file}`], { encoding: "utf8" }),
  );
}

export function packFixture(run, directory, name) {
  run("pnpm", ["build:ci-artifacts"]);
  run("node", ["--import", "./scripts/tsx.mjs", "scripts/write-unified-entry-dts.ts"]);
  run("node", [
    "scripts/package-openclaw-for-docker.mjs",
    "--skip-build",
    "--allow-unreleased-changelog",
    "--output-dir",
    directory,
    "--output-name",
    name,
  ]);
}

function selectPreviousReader(repo, base) {
  if (!base) {
    return { selected: false, reason: "not-a-pull-request" };
  }
  assert(/^[a-f0-9]{40}$/u.test(base), "downgrade requires an immutable fork-point SHA");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const previous = JSON.parse(git("show", `${base}:package.json`));
  const candidate = JSON.parse(git("show", `${head}:package.json`));
  const changedPaths = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const selected = needsSchemaDowngrade(previous, candidate, changedPaths);
  return { selected, previousSource: base, candidateSource: head, changedPaths };
}

function prepareSchemaDowngrade(repo, sourceTarball, directory, base, prebuilt) {
  const receiptFile = path.join(directory, "downgrade-source.json");
  const receipt = selectPreviousReader(repo, base);
  const head = receipt.candidateSource;
  if (!receipt.selected) {
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    return;
  }
  const packedBuild = readPackedJson(sourceTarball, "dist/build-info.json");
  assert.equal(packedBuild.commit, head, "candidate tarball is not the tested merge source");
  receipt.candidateBuild = {
    ...packedBuild,
    readerFloorSupported: /export function readStateSchemaMinReader\(/u.test(
      execFileSync("git", ["show", `${head}:src/state/openclaw-state-db-schema-version.ts`], {
        cwd: repo,
        encoding: "utf8",
      }),
    ),
  };
  if (prebuilt) {
    fs.copyFileSync(path.join(prebuilt, "previous.tgz"), path.join(directory, "previous.tgz"));
  } else {
    buildPreviousReader(repo, directory, base, packedBuild.buildId);
  }
  receipt.previousBuild = readPackedJson(
    path.join(directory, "previous.tgz"),
    "dist/build-info.json",
  );
  assert.equal(receipt.previousBuild.commit, base);
  assert(receipt.previousBuild.buildId, "previous reader must carry a build ID");
  assert.notEqual(receipt.previousBuild.buildId, packedBuild.buildId);
  fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
}

function buildPreviousReader(repo, directory, base, candidateBuildId) {
  const tree = path.join(directory, "previous-source");
  fs.mkdirSync(tree);
  const archive = path.join(directory, "previous-source.tar");
  execFileSync("git", ["archive", "--output", archive, base], { cwd: repo });
  execFileSync("tar", ["-xf", archive, "-C", tree]);
  fs.unlinkSync(archive);
  const env = {
    ...process.env,
    GIT_COMMIT: base,
    OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
    OPENCLAW_CONTROL_UI_BUILD_ID: `${candidateBuildId}-previous-${base.slice(0, 12)}`,
  };
  const run = (program, args) => execFileSync(program, args, { cwd: tree, env, stdio: "inherit" });
  try {
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);
    packFixture(run, directory, "previous.tgz");
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--select") {
    console.log(selectPreviousReader(args[1], args[2]).selected);
  } else if (args[0] === "--pack") {
    packFixture(
      (program, argv) => execFileSync(program, argv, { stdio: "inherit" }),
      args[1],
      args[2],
    );
  } else {
    prepareSchemaDowngrade(...args);
  }
}
