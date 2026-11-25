import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function proofPath(move, root = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARCHIVE_PROOF_ROOT) {
  assert(root, "pre-cleanup archive observation directory missing");
  return path.join(root, `${hash(JSON.stringify([move.sourcePath, move.archivePath]))}.bin`);
}

// Doctor exits before successful update finalization retires its verified originals.
// Observe bytes, never disable cleanup or manufacture a producer disposal receipt.
export function captureSessionArchives(stateDir, root) {
  const directory = path.join(stateDir, "session-sqlite-migration-runs");
  if (!fs.existsSync(directory)) {
    return;
  }
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    if (!manifest.completedAt || manifest.failedAt) {
      continue;
    }
    for (const target of manifest.targets) {
      if (target.validationBeforeArchive !== "passed") {
        continue;
      }
      for (const move of target.completedMoves) {
        if (
          !["legacy-store", "transcript", "trajectory"].includes(move.kind) ||
          !fs.existsSync(move.archivePath)
        ) {
          continue;
        }
        const bytes = fs.readFileSync(move.archivePath);
        try {
          fs.writeFileSync(proofPath(move, root), bytes, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code !== "EEXIST") {
            throw error;
          }
        }
      }
    }
  }
}

export function readSessionArchiveBytes(move) {
  if (move.artifact?.disposal.state !== "disposed") {
    assert(
      fs.existsSync(move.archivePath),
      "legacy session archive missing without disposal receipt",
    );
    return fs.readFileSync(move.archivePath);
  }
  assert(!fs.existsSync(move.archivePath), "disposed session archive was recreated");
  assert(
    Number.isFinite(Date.parse(move.artifact.disposal.disposedAt)),
    "completed session archive disposal time missing",
  );
  const bytes = fs.readFileSync(proofPath(move));
  assert.equal(bytes.length, move.artifact.identity.size, "disposed archive size changed");
  assert.equal(hash(bytes), move.artifact.identity.sha256, "disposed archive digest changed");
  return bytes;
}

const delegatedDoctor =
  process.argv[2] === "--doctor" &&
  path.basename(process.argv[1] ?? "") === "update-migrated-finalize.worker.js";
if (
  isMainThread &&
  process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO === "legacy-operator-state" &&
  process.env.OPENCLAW_UPGRADE_SURVIVOR_ARCHIVE_PROOF_ROOT &&
  (process.argv[2] === "doctor" || delegatedDoctor)
) {
  process.once("exit", () => {
    try {
      captureSessionArchives(
        process.env.OPENCLAW_STATE_DIR,
        process.env.OPENCLAW_UPGRADE_SURVIVOR_ARCHIVE_PROOF_ROOT,
      );
    } catch {
      // Observation cannot change Doctor; missing bytes fail the later oracle.
    }
  });
}
