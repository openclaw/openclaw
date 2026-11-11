import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

try {
  const [mode, ...numbers] = process.argv.slice(2);
  assert(["shared", "outsider"].includes(mode));
  assert(numbers.length === 4 && numbers.every((value) => /^\d{1,10}$/.test(value)));
  const [uid, gid, sharedGid, producerUid] = numbers.map(Number);
  assert(uid > 0 && gid > 0 && uid !== producerUid && gid !== sharedGid);
  assert.equal(process.getuid(), uid);
  assert.equal(process.getgid(), gid);
  const groups = process.getgroups();
  assert(groups.every((group) => group === gid || (mode === "shared" && group === sharedGid)));
  assert.equal(groups.includes(sharedGid), mode === "shared");
  // The reader can enter only the separately mounted evidence child. Even a
  // shared group must not traverse the host-owned private attempt directory.
  assert.throws(() => fs.readdirSync("/private"), { code: "EACCES" });
  if (mode === "outsider") {
    assert.throws(() => fs.readdirSync("/evidence"), { code: "EACCES" });
    assert.throws(() => fs.readFileSync("/evidence/installed-recovery.json"), { code: "EACCES" });
  } else {
    const inspectDirectory = (directory, expectedMode, owner) => {
      const stat = fs.lstatSync(directory);
      assert(stat.isDirectory() && stat.gid === sharedGid);
      assert.equal(stat.mode & 0o7777, expectedMode);
      if (owner !== undefined) {
        assert.equal(stat.uid, owner);
      }
    };
    const read = (file, summary = false) => {
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const stat = fs.fstatSync(fd);
        assert(
          stat.isFile() && stat.nlink === 1 && stat.uid === producerUid && stat.gid === sharedGid,
        );
        assert.equal(stat.mode & 0o7777, 0o640);
        if (summary) {
          assert(stat.size <= 256 * 1024);
        }
        const bytes = Buffer.alloc(summary ? stat.size : 1);
        const length = fs.readSync(fd, bytes);
        if (summary) {
          assert.equal(length, stat.size);
        }
        return bytes.subarray(0, length);
      } finally {
        fs.closeSync(fd);
      }
    };
    inspectDirectory("/evidence", 0o2770);
    const summary = JSON.parse(read("/evidence/installed-recovery.json", true));
    assert(
      summary.status === "passed" && /^installed-recovery-[A-Za-z0-9]+$/.test(summary.runDirectory),
    );
    assert.deepEqual(summary.selectedCuts, ["partial-previous"]);
    const run = path.join("/evidence", summary.runDirectory);
    inspectDirectory(run, 0o2750, producerUid);
    inspectDirectory(path.join(run, "partial-previous"), 0o2750, producerUid);
    for (const file of [
      "install.log",
      "partial-previous/displacement.out",
      "partial-previous/displacement.err",
      "partial-previous/displacement.fault.json.observed",
    ]) {
      read(path.join(run, file));
    }
  }
  console.log(
    JSON.stringify({
      installedRecoveryAccess: mode,
      uid,
      gid,
      sharedGid,
      producerUid,
      passed: true,
    }),
  );
} catch {
  console.error("[installed-recovery-access] FAILED (exit 1)");
  process.exitCode = 1;
}
