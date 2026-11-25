// The previous reader is the real fork point, not a relabeled candidate package.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertPackedSource,
  buildTypedFixture,
  fixtureGit,
  readFixtureJson,
  readPackedFixture,
  readPrebuiltFixture,
  withArchivedFixture,
  writeFixtureJson,
} from "./packed-release-fixture.mjs";

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

function selectDowngrade(repo, base) {
  if (!base) {
    return { receipt: { selected: false, reason: "not-a-pull-request" } };
  }
  assert(/^[a-f0-9]{40}$/u.test(base), "downgrade requires an immutable fork-point SHA");
  const head = fixtureGit(repo, "rev-parse", "HEAD");
  const previous = JSON.parse(fixtureGit(repo, "show", `${base}:package.json`));
  const candidate = JSON.parse(fixtureGit(repo, "show", "HEAD:package.json"));
  const changedPaths = fixtureGit(repo, "diff", "--name-only", base, head)
    .split("\n")
    .filter(Boolean);
  const selected = needsSchemaDowngrade(previous, candidate, changedPaths);
  return {
    receipt: { selected, previousSource: base, candidateSource: head, changedPaths },
    previous,
    candidate,
  };
}

async function buildPrevious(tree, directory, commit, manifest, install) {
  const metadata = await buildTypedFixture({
    tree,
    tarball: path.join(directory, "previous.tgz"),
    commit,
    buildId: `fixture-previous-${commit}`,
    install,
  });
  assertPackedSource(metadata.packed, commit, manifest, "previous reader");
  writeFixtureJson(path.join(directory, "previous-source.json"), metadata);
  return metadata;
}

function readCandidate(repo, tarball, { receipt, candidate }) {
  const packed = readPackedFixture(tarball);
  assertPackedSource(packed, receipt.candidateSource, candidate, "downgrade candidate");
  return {
    ...packed.build,
    readerFloorSupported: /export function readStateSchemaMinReader\(/u.test(
      fixtureGit(repo, "show", "HEAD:src/state/openclaw-state-db-schema-version.ts"),
    ),
  };
}

function writeRunnerReceipt(directory, { receipt, previous }, candidateBuild, packed) {
  assertPackedSource(packed, receipt.previousSource, previous, "previous reader");
  assert.notEqual(
    packed.build.buildId,
    candidateBuild.buildId,
    "downgrade requires distinct build IDs",
  );
  writeFixtureJson(path.join(directory, "downgrade-source.json"), {
    ...receipt,
    candidateBuild,
    previousBuild: packed.build,
  });
}

async function runCli([command, ...args]) {
  if (command === "--select") {
    const [repo, output, base] = args;
    const { receipt } = selectDowngrade(repo, base);
    fs.mkdirSync(output, { recursive: true });
    writeFixtureJson(path.join(output, "downgrade-source.json"), receipt);
    return;
  }
  if (command === "--build") {
    const [repo, output] = args;
    const directory = path.resolve(output);
    const selection = readFixtureJson(path.join(directory, "downgrade-source.json"));
    if (!selection.selected) {
      return;
    }
    const commit = fixtureGit(repo, "rev-parse", "HEAD");
    assert.equal(commit, selection.previousSource, "wrong fork-point checkout for previous reader");
    assert.equal(
      fixtureGit(repo, "status", "--porcelain", "--untracked-files=no"),
      "",
      "previous reader needs a clean checkout",
    );
    const manifest = JSON.parse(fixtureGit(repo, "show", "HEAD:package.json"));
    await buildPrevious(repo, directory, commit, manifest, false);
    return;
  }

  const verify = command === "--verify";
  const [repo, tarball, output, base] = verify ? args : [command, ...args];
  assert(!repo.startsWith("--"), "unknown downgrade fixture mode");
  const directory = path.resolve(output);
  const receiptPath = path.join(directory, "downgrade-source.json");
  const savedSelection = verify ? readFixtureJson(receiptPath) : null;
  fs.rmSync(receiptPath, { force: true });
  const selection = selectDowngrade(repo, base);
  const { receipt, previous } = selection;
  if (verify) {
    assert.deepEqual(
      savedSelection,
      receipt,
      "downgrade selection does not match the requested fork point and candidate",
    );
  } else {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (!receipt.selected) {
    writeFixtureJson(receiptPath, receipt);
    return;
  }
  const candidateBuild = readCandidate(repo, tarball, selection);
  if (verify) {
    const metadata = readFixtureJson(path.join(directory, "previous-source.json"));
    const packed = await readPrebuiltFixture(path.join(directory, "previous.tgz"), metadata);
    writeRunnerReceipt(directory, selection, candidateBuild, packed);
  } else {
    await withArchivedFixture(repo, base, directory, "previous-source", async (tree) => {
      const metadata = await buildPrevious(tree, directory, base, previous, true);
      writeRunnerReceipt(directory, selection, candidateBuild, metadata.packed);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runCli(process.argv.slice(2));
}
