import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, ftruncateSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const library = new URL("./release-lib.mjs", import.meta.url).pathname;
const reserve = 16 * 1024 ** 3;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "release-capacity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reference = join(root, "release with spaces\nand newline"), mirror = join(root, "mirror");
  const build = join(root, "build"), serving = join(root, "serving"), runtime = join(root, "runtime");
  for (const path of [reference, mirror, join(build, "work"), join(build, "cache"), join(serving, "staging"), runtime]) {
    mkdirSync(path, { recursive: true });
  }
  // Isolate admission from the host's available disk/inodes; all tree I/O stays real.
  const preload = join(root, "filesystem-capacity.mjs");
  writeFileSync(preload, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
fs.statfsSync = () => ({ bsize: 4096, bavail: Number(process.env.FIXTURE_BLOCKS ?? 16777216), files: 1000000, ffree: Number(process.env.FIXTURE_INODES ?? 1000000) });
syncBuiltinESMExports();
`);
  const run = (phase, env = {}) => spawnSync(process.execPath,
    ["--no-warnings", "--import", preload, library, "release-capacity", phase, reference, mirror, build, serving, runtime],
    { encoding: "utf8", env: { ...process.env, ...env }, timeout: 10000 });
  return { root, reference, mirror, run };
}

test("capacity accounts for a large tree, sparse copies, hardlinks, and untraversed symlinks", t => {
  const f = fixture(t), paths = [f.reference];
  for (let directory = 0; directory < 32; directory++) {
    const parent = join(f.reference, `package-${directory}`);
    mkdirSync(parent);
    paths.push(parent);
    for (let file = 0; file < 64; file++) {
      const path = join(parent, `module-${file}.js`);
      writeFileSync(path, "synthetic module\n");
      paths.push(path);
    }
  }
  const sparse = join(f.reference, "sparse"), hardlink = join(f.reference, "hardlink");
  const descriptor = openSync(sparse, "w");
  try { ftruncateSync(descriptor, 1024 ** 3); } finally { closeSync(descriptor); }
  linkSync(sparse, hardlink);
  // An external target and a cycle must both be counted only as symlink entries.
  const external = join(f.reference, "external"), cycle = join(f.reference, "cycle");
  symlinkSync(f.root, external);
  symlinkSync(".", cycle);
  paths.push(sparse, hardlink, external, cycle);
  const bytes = paths.reduce((total, path) => {
    const entry = lstatSync(path);
    return total + Math.max(entry.size, entry.blocks * 512);
  }, 0);
  assert.ok(bytes >= 2 * 1024 ** 3, "each sparse hardlink owes its full copy cost");
  const result = f.run("stage");
  assert.equal(result.status, 0, result.stderr);
  const { filesystems } = JSON.parse(result.stdout);
  assert.equal(filesystems.length, 1);
  assert.equal(filesystems[0].requiredBytes, reserve + bytes + paths.length * 4096);
  assert.equal(filesystems[0].requiredInodes, 16384 + paths.length);
});

test("capacity sums build destinations and refuses insufficient bytes or inodes", t => {
  const f = fixture(t);
  const descriptor = openSync(join(f.mirror, "pack"), "w");
  try { ftruncateSync(descriptor, 1024 ** 3); } finally { closeSync(descriptor); }
  const result = f.run("build");
  assert.equal(result.status, 0, result.stderr);
  const { filesystems: [disk] } = JSON.parse(result.stdout);
  const mirror = lstatSync(f.mirror), pack = lstatSync(join(f.mirror, "pack"));
  const bytes = Math.max(mirror.size, mirror.blocks * 512) + Math.max(pack.size, pack.blocks * 512);
  assert.equal(disk.requiredBytes, reserve + 3 * (bytes + 2 * 4096));
  assert.equal(disk.requiredInodes, 16384 + 3 * 2);
  for (const [env, message] of [
    [{ FIXTURE_BLOCKS: String(reserve / 4096) }, /insufficient disk space/],
    [{ FIXTURE_INODES: "16384" }, /insufficient inodes/],
  ]) {
    const refused = f.run("build", env);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, message);
  }
});

test("capacity refuses missing trees and unsupported entries without admitting a partial inventory", t => {
  const f = fixture(t);
  const fifo = spawnSync("mkfifo", [join(f.reference, "pipe")], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const unsupported = f.run("stage");
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported entry/);
  rmSync(f.reference, { recursive: true });
  assert.notEqual(f.run("stage").status, 0);
  // Activation needs only the filesystem reserve, not a release inventory.
  assert.equal(f.run("activate").status, 0);
});
