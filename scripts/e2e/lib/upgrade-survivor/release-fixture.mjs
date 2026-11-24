// Build a disposable successor from the same source as the packed PR head.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [repo, sourceTarball, directory] = process.argv.slice(2);
const readPacked = (file) =>
  JSON.parse(execFileSync("tar", ["-xOf", sourceTarball, `package/${file}`], { encoding: "utf8" }));
const manifest = readPacked("package.json");
const build = readPacked("dist/build-info.json");
const previous = {
  version: manifest.version,
  buildId: build.buildId,
  commit: build.commit,
  schema: manifest.openclaw.schemaVersions.state,
};
assert(previous.buildId && previous.commit, "T must carry its source/build identity");
assert.equal(
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  previous.commit,
  "T must be built from the selected source",
);
const tree = path.join(directory, "source");
fs.mkdirSync(tree, { recursive: true });
execFileSync("git", ["archive", "--output", path.join(directory, "source.tar"), "HEAD"], {
  cwd: repo,
});
execFileSync("tar", ["-xf", path.join(directory, "source.tar"), "-C", tree]);
fs.unlinkSync(path.join(directory, "source.tar"));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(tree, "package.json"), "utf8"));
assert.equal(sourceManifest.version, manifest.version);
const patch = (file, before, after) => {
  const filename = path.join(tree, file);
  const source = fs.readFileSync(filename, "utf8");
  assert.equal(source.split(before).length, 2, `fixture setup: moved anchor in ${file}`);
  fs.writeFileSync(filename, source.replace(before, after));
};
const schema = previous.schema + 1;
const version = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u.exec(manifest.version);
assert(version, "T must have a release version");
manifest.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}-beta.1`;
sourceManifest.version = manifest.version;
sourceManifest.openclaw.schemaVersions.state = schema;
fs.writeFileSync(path.join(tree, "package.json"), `${JSON.stringify(sourceManifest, null, 2)}\n`);
const ddl =
  "CREATE TABLE IF NOT EXISTS fixture_update_migration (\n  fixture_id TEXT NOT NULL PRIMARY KEY,\n  migrated_to INTEGER NOT NULL\n) STRICT;\n";
patch(
  "src/state/openclaw-schema-versions.ts",
  `export const OPENCLAW_STATE_SCHEMA_VERSION = ${previous.schema};`,
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
  `for (const version of [${previous.schema},`,
  `for (const version of [${schema}, ${previous.schema},`,
);
patch(
  "scripts/lib/sqlite-schema-inputs.mts",
  "      for (const [era, schema] of [",
  `      for (const [era, schema] of [\n        ["before-v${schema}", getOpenClawStatePredecessorSchema(${previous.schema})],`,
);
patch(
  "src/infra/database-engine/state-port-descriptor.ts",
  `OPENCLAW_STATE_SCHEMA_VERSION !== ${previous.schema}`,
  `OPENCLAW_STATE_SCHEMA_VERSION !== ${schema}`,
);
patch(
  "src/infra/database-engine/state-port-descriptor.ts",
  "38, 39, 40].includes(sourceVersion)",
  `38, 39, 40, ${previous.schema}].includes(sourceVersion)`,
);
const env = {
  ...process.env,
  GIT_COMMIT: previous.commit,
  OPENCLAW_CONTROL_UI_BUILD_ID: `${previous.buildId}-schema-${schema}`,
};
const run = (program, args) => execFileSync(program, args, { cwd: tree, env, stdio: "inherit" });
run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"]);
run("pnpm", ["db:postgres:gen"]);
run("pnpm", ["build:ci-artifacts"]);
run("node", ["--import", "./scripts/tsx.mjs", "scripts/write-unified-entry-dts.ts"]);
run("node", [
  "scripts/package-openclaw-for-docker.mjs",
  "--skip-build",
  "--allow-unreleased-changelog",
  "--output-dir",
  directory,
  "--output-name",
  "next.tgz",
]);
const nextBuild = JSON.parse(fs.readFileSync(path.join(tree, "dist/build-info.json"), "utf8"));
assert.equal(nextBuild.commit, previous.commit);
assert.notEqual(nextBuild.buildId, previous.buildId);
fs.writeFileSync(
  path.join(directory, "fixture.json"),
  JSON.stringify(
    {
      previous,
      next: { version: manifest.version, buildId: nextBuild.buildId, schema },
    },
    null,
    2,
  ),
);
fs.rmSync(tree, { recursive: true, force: true });
