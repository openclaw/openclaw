import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describeStandaloneRuntime } from "../../../scripts/lib/bun-standalone-contract.mjs";
import { resourceBytes } from "./stage-package.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const relativePath = (value) => typeof value === "string" && value.length > 0
  && !value.includes("\\") && !value.includes(":")
  && value.split("/").every((part) => part && part !== "." && part !== "..");

export function validateAotManifest(manifest, target, version) {
  assert.equal(manifest.schemaVersion, 1, "Unsupported standalone manifest schema");
  assert.equal(manifest.mode, "aot", "AOT desktop builds require an AOT standalone artifact");
  assert.deepEqual(manifest.target, target, "Standalone artifact target differs from the desktop target");
  assert.equal(manifest.openclaw?.version, version, "Standalone OpenClaw version differs from the desktop version");
  assert.match(manifest.openclaw?.commit ?? "", /^[a-f0-9]{40}$/, "Standalone OpenClaw source commit is missing");
  assert.match(manifest.bun?.commit ?? "", /^[a-f0-9]{40}$/, "Standalone Bun compiler commit is missing");
  assert.ok(typeof manifest.bun?.revision === "string" && manifest.bun.revision.length > 0,
    "Standalone Bun compiler revision is missing");
  assert.ok(relativePath(manifest.executable?.path) && !manifest.executable.path.includes("/"),
    "Standalone executable must be beside its manifest");
  assert.ok(relativePath(manifest.runtime?.path) && !manifest.runtime.path.includes("/"),
    "Standalone sidecar must be beside its manifest");
  assert.notEqual(manifest.executable.path, manifest.runtime.path);
  assert.notEqual(manifest.executable.path, "manifest.json");
  assert.notEqual(manifest.runtime.path, "manifest.json");
  assert.ok(sha256(manifest.executable.sha256), "Standalone executable sha256 is missing");
  assert.ok(sha256(manifest.runtime.sha256), "Standalone sidecar sha256 is missing");
  assert.ok(!manifest.build || manifest.build.flavor === "standard", "Use the standard AOT artifact, not its JIT support companion");
  if (target.platform === "darwin") {
    assert.equal(target.arch, "arm64", "macOS desktop AOT currently requires Apple Silicon");
    assert.equal(manifest.macos?.hardenedRuntime, true, "macOS AOT requires hardened runtime signing");
    for (const entitlement of [
      "com.apple.security.cs.allow-jit",
      "com.apple.security.cs.allow-unsigned-executable-memory",
    ]) {
      assert.notEqual(manifest.macos?.entitlements?.[entitlement], true,
        `macOS AOT must not grant ${entitlement}`);
    }
  }
}

export function validateAotExecutable(executable, target) {
  if (target.platform === "linux") {
    assert.ok(executable.length >= 64
      && executable.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])),
    "Linux AOT executable must be ELF64 little-endian");
    assert.equal(executable.readUInt16LE(18), target.arch === "arm64" ? 183 : 62,
      "Standalone executable architecture differs from the desktop target");
  } else {
    assert.ok(target.platform === "darwin" && target.arch === "arm64"
      && executable.length >= 32 && executable.readUInt32LE(0) === 0xfeedfacf,
    "macOS AOT executable must be a thin Mach-O 64-bit executable");
    assert.equal(executable.readUInt32LE(4), 0x0100000c,
      "Standalone executable architecture differs from the desktop target");
  }
}

function verifyMacosSignature(executable) {
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", executable], { stdio: "pipe" });
  const signature = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", executable], { encoding: "utf8" });
  assert.equal(signature.status, 0, "Cannot inspect macOS AOT signature");
  assert.match(signature.stderr, /flags=.*\bruntime\b/, "macOS AOT signature must enable hardened runtime");
  const plist = execFileSync("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", executable], { stdio: ["ignore", "pipe", "pipe"] });
  const entitlements = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
    input: plist, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }));
  for (const entitlement of [
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
  ]) {
    assert.notEqual(entitlements[entitlement], true, `macOS AOT signature must not grant ${entitlement}`);
  }
}

/** Consume the immutable executable/sidecar contract; this never invokes the compiler. */
export async function stageAotRuntime(work, target, artifact, version) {
  assert.ok(artifact, "Set OPENCLAW_DESKTOP_AOT_ARTIFACT to a prebuilt standalone artifact directory");
  assert.ok(target && ["linux", "darwin"].includes(target.platform), "Desktop AOT supports Linux glibc and macOS arm64");
  const source = path.resolve(artifact);
  assert.ok(fs.lstatSync(source).isDirectory(), "Standalone artifact must be a directory");
  const manifestPath = path.join(source, "manifest.json");
  assert.ok(fs.lstatSync(manifestPath).isFile(), "Standalone manifest must be a regular file");
  const bytes = fs.readFileSync(manifestPath);
  const standalone = JSON.parse(bytes);
  validateAotManifest(standalone, target, version);
  const executablePath = path.join(source, standalone.executable.path);
  const sidecar = path.join(source, standalone.runtime.path);
  assert.ok(fs.lstatSync(executablePath).isFile(), "Standalone executable must be a regular file");
  assert.ok(fs.lstatSync(sidecar).isDirectory(), "Standalone sidecar must be a directory");
  const executable = fs.readFileSync(executablePath);
  assert.equal(digest(executable), standalone.executable.sha256, "Standalone executable sha256 mismatch");
  validateAotExecutable(executable, target);
  const runtime = await describeStandaloneRuntime(sidecar);
  assert.equal(runtime.sha256, standalone.runtime.sha256, "Standalone sidecar sha256 mismatch");
  assert.equal(runtime.symlinkCount, 0, "Desktop runtime resources require a symlink-free standalone sidecar");
  if (target.platform === "darwin" && process.platform === "darwin") {
    verifyMacosSignature(executablePath);
  }
  const files = {};
  const write = (relative, content) => {
    const output = path.join(work, "standalone", relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, target.platform === "linux" ? resourceBytes(content) : content, { mode: 0o644 });
    files[`standalone/${relative}`] = digest(content);
  };
  write("manifest.json", bytes);
  write(standalone.executable.path, executable);
  const copy = (relative) => {
    for (const entry of fs.readdirSync(path.join(source, relative), { withFileTypes: true })) {
      assert.ok(relativePath(entry.name), "Invalid standalone resource filename");
      const file = `${relative}/${entry.name}`;
      if (entry.isDirectory()) copy(file);
      else {
        assert.ok(entry.isFile(), `Standalone resource is not a regular file: ${file}`);
        write(file, fs.readFileSync(path.join(source, file)));
      }
    }
  };
  copy(standalone.runtime.path);
  const manifest = {
    tag: `aot-${standalone.executable.sha256.slice(0, 16)}`,
    commit: standalone.bun.commit,
    revision: standalone.bun.revision,
    ...target,
    runtime: { flavor: "aot", executable: `standalone/${standalone.executable.path}`, standalone },
    files,
  };
  fs.writeFileSync(path.join(work, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
