import assert from "node:assert/strict";
import { test } from "node:test";
import { resourceBytes, runtimeTarget } from "./stage-runtime.mjs";

test("uses the requested target rather than the staging host", () => {
  assert.deepEqual(runtimeTarget("aarch64-unknown-linux-gnu"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(runtimeTarget("x86_64-unknown-linux-gnu"), { platform: "linux", arch: "x64" });
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

test("leaves macOS, Windows, and FreeBSD Tauri runtime behavior unchanged", () => {
  for (const triple of [
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "aarch64-pc-windows-msvc",
    "x86_64-unknown-freebsd",
    "aarch64-unknown-freebsd",
  ]) {
    assert.equal(runtimeTarget(triple), null, triple);
  }
});
