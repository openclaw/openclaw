import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Reproduction for issue #92109
// Demonstrates that ctimeNs-only changes (common on Btrfs due to background
// maintenance) should not be treated as a session file takeover.

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-92109-"));
  const sessionFile = path.join(tmpDir, "session.jsonl");

  try {
    await fs.writeFile(sessionFile, '{"type":"session"}\n', "utf8");

    // Read initial fingerprint
    const before = await fs.stat(sessionFile, { bigint: true });
    console.log("=== Reproduction for issue #92109 ===");
    console.log("Session file:", sessionFile);
    console.log();
    console.log("Initial fingerprint:");
    console.log("  dev:", before.dev.toString());
    console.log("  ino:", before.ino.toString());
    console.log("  size:", before.size.toString());
    console.log("  mtimeNs:", before.mtimeNs.toString());
    console.log("  ctimeNs:", before.ctimeNs.toString());

    // Simulate Btrfs background maintenance: chmod changes ctimeNs without
    // changing mtimeNs, size, or file content.
    await fs.chmod(sessionFile, 0o644);

    const after = await fs.stat(sessionFile, { bigint: true });
    console.log();
    console.log("After chmod (simulated Btrfs ctime drift):");
    console.log("  dev:", after.dev.toString());
    console.log("  ino:", after.ino.toString());
    console.log("  size:", after.size.toString());
    console.log("  mtimeNs:", after.mtimeNs.toString());
    console.log("  ctimeNs:", after.ctimeNs.toString());

    // Verify what changed
    const devChanged = before.dev !== after.dev;
    const inoChanged = before.ino !== after.ino;
    const sizeChanged = before.size !== after.size;
    const mtimeChanged = before.mtimeNs !== after.mtimeNs;
    const ctimeChanged = before.ctimeNs !== after.ctimeNs;

    console.log();
    console.log("Fields changed:");
    console.log("  dev:", devChanged ? "CHANGED" : "same");
    console.log("  ino:", inoChanged ? "CHANGED" : "same");
    console.log("  size:", sizeChanged ? "CHANGED" : "same");
    console.log("  mtimeNs:", mtimeChanged ? "CHANGED" : "same");
    console.log("  ctimeNs:", ctimeChanged ? "CHANGED" : "same");

    // Old logic (before fix): ctimeNs included → false on Btrfs
    const oldFingerprintMatch =
      !devChanged && !inoChanged && !sizeChanged && !mtimeChanged && !ctimeChanged;

    // New logic (after fix): ctimeNs excluded → true on Btrfs
    const newFingerprintMatch =
      !devChanged && !inoChanged && !sizeChanged && !mtimeChanged;

    console.log();
    console.log("sameSessionFileFingerprint result:");
    console.log("  Before fix (includes ctimeNs):", oldFingerprintMatch ? "MATCH" : "MISMATCH ← takeover");
    console.log("  After fix (excludes ctimeNs):", newFingerprintMatch ? "MATCH ← ok" : "MISMATCH");

    if (!ctimeChanged) {
      console.error("\nFAIL: Expected ctimeNs to change after chmod. This may be a non-Btrfs filesystem.");
      process.exitCode = 1;
      return;
    }

    if (!oldFingerprintMatch && newFingerprintMatch) {
      console.log("\nPASS: ctimeNs-only change no longer triggers session takeover.");
    } else {
      console.error("\nFAIL: Unexpected fingerprint comparison result.");
      process.exitCode = 1;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
