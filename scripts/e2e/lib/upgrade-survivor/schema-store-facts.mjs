// Inspect crash copies, never recover the fixture before the previous release does.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const suffixes = ["", "-wal", "-shm"];
const positiveVersion = (value) => Number.isSafeInteger(value) && value > 0;
function storePaths(stateDir) {
  // Only live owner paths: migration snapshots can contain identical basenames.
  const result = [path.join(stateDir, "state", "openclaw.sqlite")];
  const agents = path.join(stateDir, "agents");
  if (fs.existsSync(agents)) {
    for (const entry of fs.readdirSync(agents, { withFileTypes: true })) {
      assert(!entry.isSymbolicLink(), `Fixture agent must not be a symlink: ${entry.name}`);
      if (entry.isDirectory()) {
        result.push(path.join(agents, entry.name, "agent", "openclaw-agent.sqlite"));
      }
    }
  }
  return result
    .filter((filename) => fs.existsSync(filename))
    .toSorted((a, b) => a.localeCompare(b));
}
function filesAt(filename) {
  return suffixes.flatMap((suffix) => {
    const file = `${filename}${suffix}`;
    if (!fs.existsSync(file)) {
      return [];
    }
    const bytes = fs.readFileSync(file);
    return [
      { suffix, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ];
  });
}
function copyStore(source, destination) {
  assert(fs.existsSync(source), `Missing store preimage: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  for (const suffix of suffixes) {
    fs.rmSync(`${destination}${suffix}`, { force: true });
    if (fs.existsSync(`${source}${suffix}`)) {
      fs.copyFileSync(`${source}${suffix}`, `${destination}${suffix}`);
    }
  }
}
export function readSqliteStoreFacts(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const metadata = db.prepare("SELECT * FROM schema_meta WHERE meta_key = 'primary'").get();
    assert(metadata, `Missing primary schema metadata: ${filename}`);
    assert(
      ["global", "agent"].includes(metadata.role),
      `Unknown schema owner ${String(metadata.role)}: ${filename}`,
    );
    const role = metadata.role === "global" ? "shared" : "agent";
    const headerVersion = db.prepare("PRAGMA user_version").get().user_version;
    assert(
      positiveVersion(headerVersion) && positiveVersion(metadata.schema_version),
      `Invalid committed version: ${filename}`,
    );
    assert.equal(
      headerVersion,
      metadata.schema_version,
      `Uncommitted header/metadata version: ${filename}`,
    );
    let version = metadata.schema_version;
    let floor = metadata.min_reader;
    if (role === "shared") {
      const columns = db.prepare("PRAGMA table_info(config_machine_state)").all();
      const hasColumn = columns.some(({ name }) => name === "min_reader");
      const marker = db
        .prepare(
          `SELECT value_json${hasColumn ? ", min_reader" : ""} FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'`,
        )
        .get();
      if (marker) {
        const content = JSON.parse(marker.value_json);
        assert(positiveVersion(content), `Invalid content version: ${filename}`);
        version = Math.max(headerVersion, content);
      }
      floor = marker?.min_reader;
    }
    assert(positiveVersion(version), `Invalid schema version: ${filename}`);
    const hasMinReader = floor !== null && floor !== undefined;
    assert(
      !hasMinReader || (positiveVersion(floor) && floor <= version),
      `Invalid min_reader: ${filename}`,
    );
    const checks = db.prepare("PRAGMA integrity_check").all();
    assert(
      checks.length === 1 && checks[0].integrity_check === "ok",
      `Integrity failure: ${filename}`,
    );
    assert.equal(
      db.prepare("PRAGMA foreign_key_check").all().length,
      0,
      `Foreign-key failure: ${filename}`,
    );
    return {
      role,
      metadataRole: metadata.role,
      agentId: metadata.agent_id,
      version,
      headerVersion,
      metadataVersion: metadata.schema_version,
      minReader: hasMinReader ? floor : Math.max(headerVersion, version),
      hasMinReader,
      integrity: "ok",
    };
  } finally {
    db.close();
  }
}
export function inspectFixtureStores(stateDir, inspectionRoot) {
  assert(
    !fs.existsSync(inspectionRoot),
    `Inspection destination already exists: ${inspectionRoot}`,
  );
  return storePaths(stateDir).map((filename) => {
    const relativePath = path.relative(stateDir, filename);
    const inspectionPath = path.join(inspectionRoot, relativePath);
    const files = filesAt(filename);
    copyStore(filename, inspectionPath);
    return Object.assign(readSqliteStoreFacts(inspectionPath), {
      relativePath,
      path: filename,
      inspectionPath,
      files,
    });
  });
}
