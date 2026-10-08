import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceBytes, runtimeIdentity, runtimeTarget } from "./stage-runtime.mjs";

test("uses the requested target rather than the staging host", () => {
  assert.deepEqual(runtimeTarget("aarch64-unknown-linux-gnu"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(runtimeTarget("x86_64-unknown-linux-gnu"), { platform: "linux", arch: "x64" });
  assert.deepEqual(runtimeTarget("x86_64-pc-windows-msvc"), { platform: "windows", arch: "x64" });
  assert.deepEqual(runtimeTarget("aarch64-pc-windows-msvc"), { platform: "windows", arch: "arm64" });
  assert.throws(() => runtimeTarget("aarch64-unknown-linux-musl"), /Unsupported/);
});

test("hides Linux ELF resources from linuxdeploy without changing executable bytes", () => {
  const executable = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0xff]);
  const resource = resourceBytes(executable);
  const prefix = Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n");
  assert.notDeepEqual(resource.subarray(0, 4), executable.subarray(0, 4));
  assert.deepEqual(resource.subarray(0, prefix.length), prefix);
  assert.deepEqual(resource.subarray(prefix.length), executable);
});

test("leaves macOS and FreeBSD Tauri runtime behavior unchanged", () => {
  for (const triple of [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-unknown-freebsd",
    "aarch64-unknown-freebsd",
  ]) {
    assert.equal(runtimeTarget(triple), null, triple);
  }
});

for (const arch of ["x64", "arm64"]) {
  const windows = { platform: "windows", arch };
  const target = `windows-${arch}`;
  const pin = {
    tag: "unix-tag", commit: "unix-commit", revision: "unix-revision",
    artifacts: { [target]: { tag: "windows-tag", commit: "windows-commit", authenticodeSigned: false } },
  };

  test(`does not admit absent or unsigned Windows ${arch} payloads for download`, () => {
    assert.equal(runtimeIdentity({ ...pin, artifacts: {} }, windows), null);
    assert.equal(runtimeIdentity(pin, windows), null);
    assert.equal(runtimeIdentity({ ...pin, artifacts: { [target]: { authenticodeSigned: "true" } } }, windows), null);
  });

  test(`uses Windows ${arch} provenance only after signed admission`, () => {
    const signed = { ...pin, artifacts: { [target]: { ...pin.artifacts[target], authenticodeSigned: true } } };
    assert.deepEqual(runtimeIdentity(signed, windows), {
      tag: "windows-tag", commit: "windows-commit", authenticodeSigned: true,
    });
    assert.throws(() => runtimeIdentity(signed, windows, "local-artifacts"), /explicitly unsigned/);
    assert.deepEqual(runtimeIdentity(pin, { platform: "linux", arch: "x64" }), {
      tag: "unix-tag", commit: "unix-commit", revision: "unix-revision",
    });
  });

  test(`marks local unsigned Windows ${arch} proof without inheriting the Unix revision`, () => {
    assert.deepEqual(runtimeIdentity(pin, windows, "local-artifacts"), {
      tag: "windows-tag", commit: "windows-commit", authenticodeSigned: false, testOnly: true,
    });
    assert.throws(() => runtimeIdentity(pin, { platform: "linux", arch: "x64" }, "local-artifacts"), /Windows target/);
    assert.throws(() => runtimeIdentity({ ...pin, artifacts: {} }, windows, "local-artifacts"), /pinned Windows target/);
  });
}
