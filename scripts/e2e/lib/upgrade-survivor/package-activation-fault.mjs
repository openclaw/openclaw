// Loaded only by the disposable released updater and its children. The released
// writer creates every journal/helper byte; this observer never edits a receipt.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function installPackageActivationFault({ journal, evidence, cut, terminate }) {
  assert(path.isAbsolute(journal) && path.isAbsolute(evidence));
  assert(["publication-complete", "verification", "verification-rollback"].includes(cut));
  // oxlint-disable-next-line typescript/unbound-method -- Capture for interception/restoration; every call supplies the intercepted database through .call.
  const prepare = DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method -- Capture for interception/restoration; every call supplies the intercepted database through .call.
  const exec = DatabaseSync.prototype.exec;
  const armed = new WeakSet();
  const observeCommit = (db) => {
    if (!armed.has(db) || db.location() !== journal) {
      return;
    }
    armed.delete(db);
    const row = prepare.call(db, "SELECT * FROM package_activation WHERE slot = 1").get();
    if (row?.phase !== "publication-complete" || fs.existsSync(evidence)) {
      return;
    }
    fs.writeFileSync(evidence, JSON.stringify({ cut, pid: process.pid, journal, row }));
    if (cut === "publication-complete") {
      terminate();
    }
  };
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    // Released Kysely adapters can execute writes through all(), while newer
    // synchronous adapters use run(). Observe either without changing SQL.
    for (const method of ["run", "all"]) {
      const execute = statement[method];
      statement[method] = (...args) => {
        const result = execute.apply(statement, args);
        if (/\b(?:insert\s+into|update)\s+["`]?package_activation\b/iu.test(sql)) {
          armed.add(this);
        }
        if (/^\s*commit\b/iu.test(sql)) {
          observeCommit(this);
        }
        return result;
      };
    }
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql) {
    const result = exec.call(this, sql);
    if (/^\s*commit\b/iu.test(sql)) {
      observeCommit(this);
    }
    return result;
  };
}

const specPath = process.env.OPENCLAW_SURVIVOR_PACKAGE_FAULT;
if (specPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  // A real post-publication Doctor child fails, not a fabricated update result.
  if (
    ["verification", "verification-rollback"].includes(spec.cut) &&
    (process.argv.includes("doctor") || process.argv.includes("--doctor")) &&
    fs.existsSync(spec.evidence)
  ) {
    const previousManifest = path.join(spec.previousRoot, "package.json");
    // The refusal case damages rollback bytes; the recovery case must leave the
    // real retained tree intact so only the updater can authorize restoration.
    if (spec.cut === "verification") {
      fs.appendFileSync(previousManifest, "\n");
    }
    const manifestDigest = createHash("sha256")
      .update(fs.readFileSync(previousManifest))
      .digest("hex");
    fs.writeFileSync(
      `${spec.evidence}.doctor`,
      JSON.stringify({ pid: process.pid, exitCode: 1, manifestDigest }),
    );
    process.exit(1);
  }
  installPackageActivationFault({
    ...spec,
    terminate: () => process.kill(process.pid, "SIGKILL"),
  });
}
