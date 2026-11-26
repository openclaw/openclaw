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
function prepareSchemaDowngrade(repo, sourceTarball, directory, base) {
  const receiptFile = path.join(directory, "downgrade-source.json");
  if (!base) {
    fs.writeFileSync(
      receiptFile,
      JSON.stringify({ selected: false, reason: "not-a-pull-request" }),
    );
    return;
  }
  assert(/^[a-f0-9]{40}$/u.test(base), "downgrade requires an immutable fork-point SHA");
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const head = git("rev-parse", "HEAD");
  const previous = JSON.parse(git("show", `${base}:package.json`));
  const candidate = JSON.parse(git("show", `${head}:package.json`));
  const changedPaths = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const selected = needsSchemaDowngrade(previous, candidate, changedPaths);
  const receipt = { selected, previousSource: base, candidateSource: head, changedPaths };
  if (!selected) {
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    return;
  }
  const packedBuild = JSON.parse(
    execFileSync("tar", ["-xOf", sourceTarball, "package/dist/build-info.json"], {
      encoding: "utf8",
    }),
  );
  assert.equal(packedBuild.commit, head, "candidate tarball is not the tested merge source");
  receipt.candidateBuild = packedBuild;
  const baselineSchema = path.join(directory, "previous-agent-schema.sql");
  fs.writeFileSync(
    baselineSchema,
    execFileSync("git", ["show", `${base}:src/state/openclaw-agent-schema.sql`], { cwd: repo }),
  );
  execFileSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      "run",
      "test/scripts/upgrade-survivor-migration-chain.test.ts",
      "--maxWorkers=1",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        GIT_COMMIT: head,
        OPENCLAW_SCHEMA_DOWNGRADE_BASE_SHA: base,
        OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE_SCHEMA: baselineSchema,
        OPENCLAW_UPGRADE_SURVIVOR_BULK_BASELINE: String(previous.openclaw.schemaVersions.agent),
      },
      stdio: "inherit",
    },
  );
  const tree = path.join(directory, "previous-source");
  fs.mkdirSync(tree);
  const archive = path.join(directory, "previous-source.tar");
  execFileSync("git", ["archive", "--output", archive, base], { cwd: repo });
  execFileSync("tar", ["-xf", archive, "-C", tree]);
  fs.unlinkSync(archive);
  const env = {
    ...process.env,
    GIT_COMMIT: base,
    OPENCLAW_CONTROL_UI_BUILD_ID: `${packedBuild.buildId}-previous-${base.slice(0, 12)}`,
  };
  const run = (program, args) => execFileSync(program, args, { cwd: tree, env, stdio: "inherit" });
  try {
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);
    run("pnpm", ["build:ci-artifacts"]);
    run("node", ["--import", "./scripts/tsx.mjs", "scripts/write-unified-entry-dts.ts"]);
    run("node", [
      "scripts/package-openclaw-for-docker.mjs",
      "--skip-build",
      "--allow-unreleased-changelog",
      "--output-dir",
      directory,
      "--output-name",
      "previous.tgz",
    ]);
    receipt.previousBuild = JSON.parse(
      fs.readFileSync(path.join(tree, "dist/build-info.json"), "utf8"),
    );
    assert.equal(receipt.previousBuild.commit, base);
    assert.notEqual(receipt.previousBuild.buildId, packedBuild.buildId);
    fs.writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareSchemaDowngrade(...process.argv.slice(2));
}
