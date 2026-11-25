// Build a disposable successor from the same source as the packed PR head.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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

function releaseSource(repo) {
  const commit = fixtureGit(repo, "rev-parse", "HEAD");
  const manifest = JSON.parse(fixtureGit(repo, "show", "HEAD:package.json"));
  const previousSchema = manifest.openclaw.schemaVersions.state;
  assert(Number.isSafeInteger(previousSchema) && previousSchema > 0, "invalid source state schema");
  const version = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u.exec(manifest.version);
  assert(version, "T must have a release version");
  const successor = structuredClone(manifest);
  successor.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}-beta.1`;
  successor.openclaw.schemaVersions.state = previousSchema + 1;
  return { commit, manifest, successor };
}

function patchSource(tree, previousSchema, sourceManifest) {
  const schema = sourceManifest.openclaw.schemaVersions.state;
  const patch = (file, before, after) => {
    const filename = path.join(tree, file);
    const source = fs.readFileSync(filename, "utf8");
    assert.equal(source.split(before).length, 2, `fixture setup: moved anchor in ${file}`);
    fs.writeFileSync(filename, source.replace(before, after));
  };
  writeFixtureJson(path.join(tree, "package.json"), sourceManifest);
  const ddl =
    "CREATE TABLE IF NOT EXISTS fixture_update_migration (\n  fixture_id TEXT NOT NULL PRIMARY KEY,\n  migrated_to INTEGER NOT NULL\n) STRICT;\n";
  patch(
    "src/state/openclaw-schema-versions.ts",
    `export const OPENCLAW_STATE_SCHEMA_VERSION = ${previousSchema};`,
    `export const OPENCLAW_STATE_SCHEMA_VERSION = ${schema};`,
  );
  fs.appendFileSync(path.join(tree, "src/state/openclaw-state-schema.sql"), `\n${ddl}`);
  fs.writeFileSync(
    path.join(tree, "src/state/openclaw-state-db-schema-fixture.ts"),
    `
import type { DatabaseSync } from "node:sqlite";
export const fixtureUpdateMigration = {
  version: ${schema}, tables: ["fixture_update_migration", "mcp_oauth_stores"], columns: [],
  migrate(db: DatabaseSync, previousVersion: number): boolean {
    if (previousVersion >= ${schema}) return false;
    db.exec(${JSON.stringify(ddl)});
    db.prepare("INSERT OR IGNORE INTO fixture_update_migration VALUES (?, ?)").run("release", ${schema});
    db.exec(\`UPDATE mcp_oauth_stores SET store_json = '{"migrated":true}' WHERE store_key LIKE 'release-survivor-%'\`);
    return true;
  }, applied: "Applied release survivor fixture migration",
};
`,
  );
  const maintenance = "src/state/openclaw-state-db-maintenance.ts";
  patch(
    maintenance,
    'import type { DatabaseSync } from "node:sqlite";',
    'import type { DatabaseSync } from "node:sqlite";\nimport { fixtureUpdateMigration } from "./openclaw-state-db-schema-fixture.js";',
  );
  patch(
    maintenance,
    "  stateApprovalProfileMigration,\n] as const;",
    "  stateApprovalProfileMigration,\n  fixtureUpdateMigration,\n] as const;",
  );
  patch(
    maintenance,
    "    stateApprovalProfileMigration,\n  ];",
    "    stateApprovalProfileMigration,\n    fixtureUpdateMigration,\n  ];",
  );
  patch(
    "src/state/openclaw-state-schema-runtime.ts",
    "  let schema = OPENCLAW_STATE_SCHEMA_SQL;",
    `  let schema = OPENCLAW_STATE_SCHEMA_SQL;\n  if (version < ${schema}) schema = schema.replace(${JSON.stringify(ddl)}, "");`,
  );
  patch(
    "scripts/lib/sqlite-schema-inputs.mts",
    `for (const version of [${previousSchema},`,
    `for (const version of [${schema}, ${previousSchema},`,
  );
  patch(
    "scripts/lib/sqlite-schema-inputs.mts",
    "      for (const [era, schema] of [",
    `      for (const [era, schema] of [\n        ["before-v${schema}", getOpenClawStatePredecessorSchema(${previousSchema})],`,
  );
  patch(
    "src/infra/database-engine/state-port-descriptor.ts",
    `OPENCLAW_STATE_SCHEMA_VERSION !== ${previousSchema}`,
    `OPENCLAW_STATE_SCHEMA_VERSION !== ${schema}`,
  );
  patch(
    "src/infra/database-engine/state-port-descriptor.ts",
    "38, 39, 40].includes(sourceVersion)",
    `38, 39, 40, ${previousSchema}].includes(sourceVersion)`,
  );
}

async function buildSuccessor(tree, directory, source, startedAt, install) {
  const { commit, manifest, successor } = source;
  patchSource(tree, manifest.openclaw.schemaVersions.state, successor);
  const timingsMs = { sourceSetup: Math.round(performance.now() - startedAt) };
  const tarball = path.join(directory, "next.tgz");
  const metadata = await buildTypedFixture({
    tree,
    tarball,
    commit,
    buildId: `fixture-next-${commit}-schema-${successor.openclaw.schemaVersions.state}`,
    install,
    generateSchema: true,
    timingsMs,
  });
  assertPackedSource(metadata.packed, commit, successor, "T+1");
  const prepared = { ...metadata, timingsMs };
  writeFixtureJson(path.join(directory, "next-source.json"), prepared);
  return prepared;
}

function readBaseline(tarball, { commit, manifest }) {
  const packed = readPackedFixture(tarball);
  assertPackedSource(packed, commit, manifest, "T");
  const { version, buildId } = packed.build;
  return { version, buildId, commit, schema: packed.schemaVersions.state };
}

function writeRunnerFixture(directory, previous, { commit, successor }, next, timingsMs) {
  assertPackedSource(next, commit, successor, "T+1");
  assert.notEqual(next.build.buildId, previous.buildId, "T and T+1 must have distinct build IDs");
  for (const phase of ["sourceSetup", "schemaGeneration", "build", "declarations", "package"]) {
    const value = timingsMs?.[phase];
    assert(Number.isSafeInteger(value) && value >= 0, `invalid T+1 ${phase} timing`);
  }
  writeFixtureJson(path.join(directory, "fixture.json"), {
    previous,
    next: {
      version: next.build.version,
      buildId: next.build.buildId,
      schema: next.schemaVersions.state,
    },
    timingsMs,
  });
}

const [command, ...args] = process.argv.slice(2);
if (command === "--prepare") {
  const [repo, output] = args;
  const startedAt = performance.now();
  const directory = path.resolve(output);
  const source = releaseSource(repo);
  assert.equal(
    fixtureGit(repo, "status", "--porcelain", "--untracked-files=no"),
    "",
    "T+1 needs a clean, dedicated checkout",
  );
  fs.mkdirSync(directory, { recursive: true });
  await buildSuccessor(repo, directory, source, startedAt, false);
} else {
  const [repo, tarball, output] = command === "--verify" ? args : [command, ...args];
  assert(!repo.startsWith("--"), "unknown release fixture mode");
  const startedAt = performance.now();
  const directory = path.resolve(output);
  fs.rmSync(path.join(directory, "fixture.json"), { force: true });
  const source = releaseSource(repo);
  const previous = readBaseline(tarball, source);
  if (command === "--verify") {
    const metadata = readFixtureJson(path.join(directory, "next-source.json"));
    const next = await readPrebuiltFixture(path.join(directory, "next.tgz"), metadata);
    writeRunnerFixture(directory, previous, source, next, metadata.timingsMs);
  } else {
    fs.mkdirSync(directory, { recursive: true });
    await withArchivedFixture(repo, source.commit, directory, "source", async (tree) => {
      const metadata = await buildSuccessor(tree, directory, source, startedAt, true);
      writeRunnerFixture(directory, previous, source, metadata.packed, metadata.timingsMs);
    });
  }
}
