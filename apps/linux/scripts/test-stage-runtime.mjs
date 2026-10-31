import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resourceBytes, runtimeFlavor, runtimeTarget, stageWindowsRuntime } from "./stage-runtime.mjs";
import { stageAotRuntime, validateAotExecutable, validateAotManifest } from "./stage-standalone.mjs";

test("uses the requested target rather than the staging host", () => {
  assert.deepEqual(runtimeTarget("aarch64-unknown-linux-gnu"), { platform: "linux", arch: "arm64" });
  assert.deepEqual(runtimeTarget("x86_64-unknown-linux-gnu"), { platform: "linux", arch: "x64" });
  assert.deepEqual(runtimeTarget("x86_64-pc-windows-msvc"), { platform: "windows", arch: "x64" });
  assert.deepEqual(runtimeTarget("aarch64-pc-windows-msvc"), { platform: "windows", arch: "arm64" });
  assert.deepEqual(runtimeTarget("aarch64-apple-darwin"), { platform: "darwin", arch: "arm64" });
  assert.deepEqual(runtimeTarget("x86_64-apple-darwin"), { platform: "darwin", arch: "x64" });
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

test("leaves unsupported FreeBSD builds without an embedded runtime", () => {
  for (const triple of [
    "x86_64-unknown-freebsd",
    "aarch64-unknown-freebsd",
  ]) {
    assert.equal(runtimeTarget(triple), null, triple);
  }
});

test("accepts only the two explicit desktop runtime flavors", () => {
  assert.equal(runtimeFlavor("jit"), "jit");
  assert.equal(runtimeFlavor("aot"), "aot");
  for (const flavor of ["", "bytecode", "AOT", "auto"]) {
    assert.throws(() => runtimeFlavor(flavor), /must be jit or aot/);
  }
});

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("runtime-only fixture staging preserves Bun without building the disposable package", { skip: process.platform === "win32" }, (t) => {
  // openclaw-temp-dir: allow exercises the real staging CLI without downloading or building a package
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-staging-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "apps/linux/scripts");
  const destination = path.join(root, "apps/linux/src-tauri/target/desktop-runtime");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL("./stage-runtime.mjs", import.meta.url)), path.join(scripts, "stage-runtime.mjs"));
  fs.symlinkSync(fileURLToPath(new URL("./stage-package.mjs", import.meta.url)), path.join(scripts, "stage-package.mjs"));
  fs.symlinkSync(fileURLToPath(new URL("./stage-standalone.mjs", import.meta.url)), path.join(scripts, "stage-standalone.mjs"));
  fs.symlinkSync(fileURLToPath(new URL("../../../scripts/lib/desktop-runtime-plugins.mjs", import.meta.url)), path.join(root, "scripts/lib/desktop-runtime-plugins.mjs"));
  fs.symlinkSync(fileURLToPath(new URL("../../../scripts/lib/bun-standalone-sqlite.mjs", import.meta.url)), path.join(root, "scripts/lib/bun-standalone-sqlite.mjs"));
  const pin = { tag: "test-pin", commit: "a".repeat(40), revision: "test-revision" };
  fs.writeFileSync(path.join(root, "scripts/lib/openclaw-bun.json"), JSON.stringify(pin));
  fs.writeFileSync(path.join(root, "scripts/lib/sqlite-macos.json"), JSON.stringify({ version: "3.53.4" }));
  const bun = Buffer.from('#!/bin/sh\nprintf \'{"version":"3.53.4","extensionLoadingSupported":true,"compileOptions":[]}\\n\'\n');
  fs.writeFileSync(path.join(root, "scripts/synthetic-bun"), bun);
  fs.writeFileSync(path.join(root, "scripts/stage-openclaw-bun.sh"), '#!/bin/sh\nmkdir -p "$1/bin"\ncp scripts/synthetic-bun "$1/bin/bun"\nchmod +x "$1/bin/bun"\nprintf "{}" > "$1/bun-manifest.json"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, "scripts/build-mac-sqlite.sh"), '#!/bin/sh\nmkdir -p "$2/lib"\nprintf "synthetic sqlite" > "$2/lib/libsqlite3.dylib"\n');
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"0.0.0"}');
  fs.writeFileSync(path.join(root, "scripts/package-openclaw-for-docker.mjs"), 'import fs from "node:fs"; fs.writeFileSync("package-build-started", "yes"); throw new Error("package build refused by fixture");');
  const env = { ...process.env, TAURI_ENV_TARGET_TRIPLE: "x86_64-unknown-linux-gnu" };
  delete env.RELEASE_TAG;
  delete env.RELEASE_SHA;
  delete env.OPENCLAW_DESKTOP_RUNTIME;
  execFileSync("git", ["init", "-q", root], { env });
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture", "--allow-empty"], { env });
  const stage = (...args) => spawnSync(process.execPath, [path.join(scripts, "stage-runtime.mjs"), ...args], { cwd: root, env, encoding: "utf8" });

  fs.writeFileSync(path.join(destination, "old-resource"), "preserved on failure");
  const full = stage();
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /package build refused by fixture/);
  assert.equal(fs.readFileSync(path.join(root, "package-build-started"), "utf8"), "yes");
  assert.equal(fs.readFileSync(path.join(destination, "old-resource"), "utf8"), "preserved on failure");
  fs.rmSync(path.join(root, "package-build-started"));

  const fixture = stage("--runtime-only");
  assert.equal(fixture.status, 0, fixture.stderr);
  assert.equal(fs.existsSync(path.join(root, "package-build-started")), false);
  assert.deepEqual(fs.readFileSync(path.join(destination, "bin/bun")), Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), bun]));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"), "utf8")), {
    ...pin, platform: "linux", arch: "x64", files: { "bin/bun": hash(bun) },
    runtime: { flavor: "jit", executable: "bin/bun" },
  });
  assert.deepEqual(fs.readdirSync(destination).toSorted(), ["bin", "manifest.json"]);
  assert.deepEqual(fs.readdirSync(path.dirname(destination)), ["desktop-runtime"]);

  const aot = aotFixture(t);
  fs.writeFileSync(path.join(root, "package.json"), '{"version":"2026.10.7"}');
  env.OPENCLAW_DESKTOP_RUNTIME = "aot";
  env.OPENCLAW_DESKTOP_AOT_ARTIFACT = aot.source;
  env.RELEASE_TAG = "v2026.10.7";
  env.RELEASE_SHA = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.notEqual(env.RELEASE_SHA, aot.manifest.openclaw.commit);
  const standalone = stage();
  assert.equal(standalone.status, 0, standalone.stderr);
  assert.equal(fs.existsSync(path.join(root, "package-build-started")), false);
  const aotManifest = fs.readFileSync(path.join(destination, "manifest.json"), "utf8");
  assert.equal(JSON.parse(aotManifest).runtime.flavor, "aot");
  env.RELEASE_SHA = "c".repeat(40);
  const wrongRelease = stage();
  assert.notEqual(wrongRelease.status, 0);
  assert.match(wrongRelease.stderr, /does not match source commit/);
  assert.equal(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"), aotManifest);
  delete env.RELEASE_TAG;
  delete env.RELEASE_SHA;
  fs.writeFileSync(path.join(aot.source, "openclaw"), "corrupt");
  assert.notEqual(stage().status, 0);
  assert.equal(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"), aotManifest);

  env.OPENCLAW_DESKTOP_RUNTIME = "jit";
  env.TAURI_ENV_TARGET_TRIPLE = "aarch64-apple-darwin";
  const macJit = stage("--runtime-only");
  assert.equal(macJit.status, 0, macJit.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, "manifest.json"))).runtime.flavor, "jit");
  assert.deepEqual(fs.readFileSync(path.join(destination, "bin/bun")), bun);
  const sqlite = fs.readFileSync(path.join(destination, "lib/libsqlite3.dylib"));
  assert.equal(sqlite.toString(), "synthetic sqlite");
  const macManifest = fs.readFileSync(path.join(destination, "manifest.json"), "utf8");
  assert.deepEqual(JSON.parse(macManifest).files, {
    "bin/bun": hash(bun), "lib/libsqlite3.dylib": hash(sqlite),
  });

  fs.writeFileSync(path.join(root, "scripts/build-mac-sqlite.sh"), '#!/bin/sh\necho "synthetic SQLite build failed" >&2\nexit 17\n');
  const brokenSqlite = stage("--runtime-only");
  assert.notEqual(brokenSqlite.status, 0);
  assert.match(brokenSqlite.stderr, /Standalone SQLite preparation failed/);
  assert.equal(fs.readFileSync(path.join(destination, "manifest.json"), "utf8"), macManifest);
  assert.equal(fs.readFileSync(path.join(destination, "lib/libsqlite3.dylib"), "utf8"), "synthetic sqlite");
});


function aotFixture(t, target = { platform: "linux", arch: "x64" }) {
  // openclaw-temp-dir: allow verifies immutable synthetic executable and sidecar publication
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-aot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const work = path.join(root, "work");
  fs.mkdirSync(path.join(source, "runtime/dist"), { recursive: true });
  fs.mkdirSync(work);
  const executable = Buffer.alloc(target.platform === "linux" ? 64 : 32);
  if (target.platform === "linux") {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(executable);
    executable.writeUInt16LE(target.arch === "arm64" ? 183 : 62, 18);
  } else {
    executable.writeUInt32LE(0xfeedfacf, 0);
    executable.writeUInt32LE(0x0100000c, 4);
  }
  const metadata = Buffer.from('{"name":"openclaw"}\n');
  fs.writeFileSync(path.join(source, "openclaw"), executable);
  fs.writeFileSync(path.join(source, "runtime/dist/package.json"), metadata);
  const manifest = {
    schemaVersion: 1, mode: "aot", target,
    build: { flavor: "standard" },
    openclaw: { version: "2026.10.7", commit: "b".repeat(40) },
    bun: { version: "1.4.4", revision: "1.4.4+test", commit: "a".repeat(40) },
    executable: { path: "openclaw", sha256: hash(executable) },
    runtime: { path: "runtime", sha256: hash(`dist/package.json\0file\0${hash(metadata)}\n`) },
    ...(target.platform === "darwin" ? { macos: { hardenedRuntime: true, entitlements: {} } } : {}),
  };
  const save = () => fs.writeFileSync(path.join(source, "manifest.json"), `${JSON.stringify(manifest)}\n`);
  save();
  return { source, work, manifest, save, executable, metadata };
}

for (const arch of ["x64", "arm64"]) {
  test(`stages the ${arch} AOT invocation and verifies unmodified sidecar resources`, async (t) => {
    const target = { platform: "linux", arch };
    const { source, work, manifest, executable, metadata } = aotFixture(t, target);
    const before = fs.readFileSync(path.join(source, "manifest.json"));
    const staged = await stageAotRuntime(work, target, source, "2026.10.7");
    assert.deepEqual(staged.runtime, { flavor: "aot", executable: "standalone/openclaw", standalone: manifest });
    assert.deepEqual(fs.readFileSync(path.join(work, "standalone/openclaw")), resourceBytes(executable));
    assert.deepEqual(fs.readFileSync(path.join(work, "standalone/runtime/dist/package.json")), resourceBytes(metadata));
    assert.equal(staged.files["standalone/manifest.json"], hash(before));
    assert.equal(staged.files["standalone/openclaw"], manifest.executable.sha256);
    assert.equal(staged.files["standalone/runtime/dist/package.json"], hash(metadata));
    assert.deepEqual(fs.readFileSync(path.join(source, "manifest.json")), before);
    assert.deepEqual(fs.readFileSync(path.join(source, "openclaw")), executable);
    assert.equal(fs.existsSync(path.join(work, "package")), false);
  });
}

test("rejects a corrupt executable or sidecar before writing AOT resources", async (t) => {
  const { source, work, executable, manifest } = aotFixture(t);
  fs.writeFileSync(path.join(source, "openclaw"), "corrupt executable");
  await assert.rejects(stageAotRuntime(work, manifest.target, source, "2026.10.7"), /executable sha256 mismatch/);
  assert.deepEqual(fs.readdirSync(work), []);
  fs.writeFileSync(path.join(source, "openclaw"), executable);
  fs.writeFileSync(path.join(source, "runtime/dist/package.json"), "corrupt sidecar");
  await assert.rejects(stageAotRuntime(work, manifest.target, source, "2026.10.7"), /sidecar sha256 mismatch/);
  assert.deepEqual(fs.readdirSync(work), []);
});

test("rejects a foreign-architecture executable even when its manifest and checksum match", async (t) => {
  const { source, work, executable, manifest, save } = aotFixture(t);
  executable.writeUInt16LE(183, 18);
  fs.writeFileSync(path.join(source, "openclaw"), executable);
  manifest.executable.sha256 = hash(executable);
  save();
  await assert.rejects(stageAotRuntime(work, manifest.target, source, "2026.10.7"), /architecture differs/);
  assert.deepEqual(fs.readdirSync(work), []);
});

test("checks the executable format and architecture on Linux and macOS", (t) => {
  const linux = aotFixture(t);
  validateAotExecutable(linux.executable, linux.manifest.target);
  for (const offset of [0, 4, 5]) {
    const invalid = Buffer.from(linux.executable);
    invalid[offset] = 0;
    assert.throws(() => validateAotExecutable(invalid, linux.manifest.target), /ELF64 little-endian/);
  }
  assert.throws(() => validateAotExecutable(linux.executable.subarray(0, 18), linux.manifest.target), /ELF64 little-endian/);
  const mac = aotFixture(t, { platform: "darwin", arch: "arm64" });
  validateAotExecutable(mac.executable, mac.manifest.target);
  const intel = Buffer.from(mac.executable);
  intel.writeUInt32LE(0x01000007, 4);
  assert.throws(() => validateAotExecutable(intel, mac.manifest.target), /architecture differs/);
  assert.throws(() => validateAotExecutable(linux.executable, mac.manifest.target), /Mach-O 64-bit/);
  assert.throws(() => validateAotExecutable(mac.executable.subarray(0, 16), mac.manifest.target), /Mach-O 64-bit/);
});

test("rejects mismatched AOT identity and unsafe invocation paths", (t) => {
  const { manifest } = aotFixture(t);
  assert.throws(() => validateAotManifest(manifest, { platform: "linux", arch: "arm64" }, "2026.10.7"), /target differs/);
  assert.throws(() => validateAotManifest(manifest, manifest.target, "2026.10.8"), /version differs/);
  for (const [field, value, error] of [
    ["mode", "jit", /AOT standalone/],
    ["build", { flavor: "support" }, /JIT support companion/],
    ["executable", { ...manifest.executable, path: "../openclaw" }, /beside its manifest/],
    ["runtime", { ...manifest.runtime, path: "/runtime" }, /beside its manifest/],
  ]) {
    assert.throws(() => validateAotManifest({ ...manifest, [field]: value }, manifest.target, "2026.10.7"), error);
  }
});

test("macOS AOT requires Apple Silicon and a hardened policy without JIT entitlements", (t) => {
  const { manifest } = aotFixture(t, { platform: "darwin", arch: "arm64" });
  validateAotManifest(manifest, manifest.target, "2026.10.7");
  const intel = { ...manifest, target: { platform: "darwin", arch: "x64" } };
  assert.throws(() => validateAotManifest(intel, intel.target, "2026.10.7"), /Apple Silicon/);
  for (const entitlement of ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"]) {
    assert.throws(() => validateAotManifest({ ...manifest, macos: { hardenedRuntime: true, entitlements: { [entitlement]: true } } }, manifest.target, "2026.10.7"), /must not grant/);
  }
});

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
