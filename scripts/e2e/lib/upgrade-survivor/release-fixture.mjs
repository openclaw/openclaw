// Build a disposable successor from the same source as the packed PR head.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { packFixture, readPackedJson } from "./schema-downgrade-source.mjs";

const args = process.argv.slice(2);
const buildOnly = args[0] === "--prepare";
const [repo, sourceTarball, directory, prebuilt] = buildOnly ? [args[1], undefined, args[2]] : args;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const manifest = buildOnly
  ? JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"))
  : readPackedJson(sourceTarball, "package.json");
const previousSchema = manifest.openclaw.schemaVersions.state;
const schema = previousSchema + 1;
const build = buildOnly ? undefined : readPackedJson(sourceTarball, "dist/build-info.json");
const tarball = path.join(directory, "next.tgz");
function writeReceipt() {
  const next = readPackedJson(tarball, "dist/build-info.json");
  const nextManifest = readPackedJson(tarball, "package.json");
  assert.equal(next.commit, commit, "T+1 must be built from the selected source");
  assert(next.buildId && next.buildId !== build.buildId, "T and T+1 need distinct build IDs");
  assert.equal(
    nextManifest.openclaw.schemaVersions.state,
    schema,
    "T+1 must advance the schema by one",
  );
  fs.writeFileSync(
    path.join(directory, "fixture.json"),
    JSON.stringify({
      previous: {
        version: manifest.version,
        buildId: build.buildId,
        commit,
        schema: previousSchema,
      },
      next: { version: nextManifest.version, buildId: next.buildId, schema },
    }),
  );
}
if (!buildOnly) {
  assert(
    build.buildId && build.commit === commit,
    "T must carry the selected source/build identity",
  );
}
if (prebuilt) {
  fs.copyFileSync(path.join(prebuilt, "next.tgz"), tarball);
  writeReceipt();
  process.exit(0);
}
// Hosted preparation owns its checkout; inline callers keep their checkout untouched.
const tree = buildOnly ? repo : path.join(directory, "source");
fs.mkdirSync(directory, { recursive: true });
if (!buildOnly) {
  fs.mkdirSync(tree);
  const archive = path.join(directory, "source.tar");
  execFileSync("git", ["archive", "--output", archive, "HEAD"], { cwd: repo });
  execFileSync("tar", ["-xf", archive, "-C", tree]);
  fs.unlinkSync(archive);
}
const sourceManifest = buildOnly
  ? manifest
  : JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8"));
assert.equal(sourceManifest.version, manifest.version);
const patch = (file, before, after) => {
  const filename = path.join(tree, file);
  const source = fs.readFileSync(filename, "utf8");
  assert.equal(source.split(before).length, 2, `fixture setup: moved anchor in ${file}`);
  fs.writeFileSync(filename, source.replace(before, after));
};
const version = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u.exec(manifest.version);
assert(version, "T must have a release version");
sourceManifest.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}-beta.1`;
sourceManifest.openclaw.schemaVersions.state = schema;
fs.writeFileSync(path.join(tree, "package.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
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
const env = {
  ...process.env,
  GIT_COMMIT: commit,
  OPENCLAW_CONTROL_UI_BUILD_ID: `fixture-next-${commit}-schema-${schema}`,
  OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "0",
};
const run = (program, argv) => execFileSync(program, argv, { cwd: tree, env, stdio: "inherit" });
if (!buildOnly) {
  run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);
}
run("pnpm", ["db:postgres:gen"]);
packFixture(run, directory, "next.tgz");
if (!buildOnly) {
  fs.rmSync(tree, { recursive: true, force: true });
  writeReceipt();
}
