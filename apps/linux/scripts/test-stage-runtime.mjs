import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { resourceBytes, runtimeTarget, stageWindowsRuntime } from "./stage-runtime.mjs";

test("uses the requested target rather than the staging host", () => {
  assert.deepEqual(runtimeTarget("aarch64-unknown-linux-gnu"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(runtimeTarget("x86_64-unknown-linux-gnu"), { platform: "linux", arch: "x64" });
  assert.deepEqual(runtimeTarget("x86_64-pc-windows-msvc"), { platform: "windows", arch: "x64" });
  assert.deepEqual(runtimeTarget("aarch64-pc-windows-msvc"), { platform: "windows", arch: "arm64" });
  assert.throws(() => runtimeTarget("aarch64-unknown-linux-musl"), /Unsupported/);
  assert.throws(() => runtimeTarget("i686-pc-windows-msvc"), /Unsupported/);
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

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const signerSubject = "CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US";
// Synthetic PE header in a stored ZIP; no executable code or real runtime is included.
const archive = Buffer.from("UEsDBBQAAAAAALiRS12hAcWLYAAAAGAAAAAXAAAAYnVuLXdpbmRvd3MteDY0L2J1bi5leGVNWgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAUEUAAGSGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABQSwECFAMUAAAAAAC4kUtdoQHFi2AAAABgAAAAFwAAAAAAAAAAAAAAgAEAAAAAYnVuLXdpbmRvd3MteDY0L2J1bi5leGVQSwUGAAAAAAEAAQBFAAAAlQAAAAAA", "base64");
const executable = archive.subarray(53, 149);

function releaseFixture(t) {
  // openclaw-temp-dir: allow verifies raw runtime resource publication and cleanup
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "windows-runtime-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const pin = {
    tag: "test-pin", commit: "a".repeat(40), revision: "test-revision",
    artifacts: { "windows-x64": {
      asset: "bun-windows-x64.zip", sha256: hash(archive),
      executable: "bun-windows-x64/bun.exe", executableSha256: hash(executable),
    } },
  };
  const manifest = {
    repository: "openclaw/bun", tag: pin.tag, bun: { commit: pin.commit, revision: pin.revision },
    assets: [{ target: "windows-x64", os: "windows", arch: "x64", name: pin.artifacts["windows-x64"].asset,
      sha256: hash(archive), executable: { path: pin.artifacts["windows-x64"].executable,
        sha256: hash(executable), authenticodeSigned: true, testOnly: false, signerSubject } }],
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    const name = new URL(url).pathname.split("/").at(-1);
    assert.equal(new URL(url).pathname.split("/").at(-2), pin.tag);
    return new Response(name === "manifest.json" ? bytes : name === "SHA256SUMS"
      ? `${hash(bytes)}  manifest.json\n${hash(archive)}  bun-windows-x64.zip\n` : archive);
  });
  return { work, pin, manifest };
}

for (const signingMetadata of [false, true]) {
  test(`stages admitted Windows bytes with ${signingMetadata ? "signing metadata" : "a four-field pin"}`, async (t) => {
    const { work, pin } = releaseFixture(t);
    if (signingMetadata) Object.assign(pin.artifacts["windows-x64"], { authenticodeSigned: true, testOnly: false, signerSubject });
    assert.equal(await stageWindowsRuntime(work, { platform: "windows", arch: "x64" }, pin), true);
    assert.deepEqual(fs.readFileSync(path.join(work, "bin/bun.exe")), executable);
    const embedded = JSON.parse(fs.readFileSync(path.join(work, "manifest.json"), "utf8"));
    assert.equal(embedded.authenticodeSigned, true);
    assert.equal(embedded.testOnly, false);
    assert.deepEqual(embedded.files, { "bin/bun.exe": hash(executable) });
  });
}

test("missing Windows pin stages no runtime and never falls back to another platform", async (t) => {
  const { work, pin } = releaseFixture(t);
  pin.artifacts = { "linux-x64": pin.artifacts["windows-x64"] };
  assert.equal(await stageWindowsRuntime(work, { platform: "windows", arch: "x64" }, pin), false);
  assert.deepEqual(fs.readdirSync(work), []);
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test("refuses unsigned, test-only, foreign-platform, and unpinned Windows release bytes", async (t) => {
  const { work, pin, manifest } = releaseFixture(t);
  const asset = manifest.assets[0];
  const pinned = pin.artifacts["windows-x64"];
  for (const [object, key, rejected, expected] of [
    [asset.executable, "authenticodeSigned", false, /Authenticode signed/],
    [asset.executable, "testOnly", true, /Test-only/],
    [asset.executable, "signerSubject", "CN=Another publisher", /signer mismatch/],
    [asset.executable, "signerSubject", undefined, /signer mismatch/],
    [asset, "os", "linux", /platform mismatch/],
    [asset, "sha256", "0".repeat(64), /differs from pin/],
    [pinned, "authenticodeSigned", false, /differs from pin/],
    [pinned, "testOnly", true, /differs from pin/],
    [pinned, "signerSubject", "CN=Another publisher", /differs from pin/],
  ]) {
    const existed = Object.hasOwn(object, key);
    const original = object[key];
    object[key] = rejected;
    await assert.rejects(stageWindowsRuntime(work, { platform: "windows", arch: "x64" }, pin), expected);
    assert.deepEqual(fs.readdirSync(work), []);
    if (existed) object[key] = original;
    else delete object[key];
  }
});
