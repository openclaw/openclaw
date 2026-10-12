import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const destination = path.join(root, "apps/linux/src-tauri/target/desktop-runtime");

export function resourceBytes(executable) {
  // linuxdeploy rewrites ELF resources even without executable permissions.
  // This fixed envelope is stripped by bundled_runtime.rs; hashes cover raw bytes.
  return Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), executable]);
}

export function runtimeTarget(triple) {
  if (
    triple.endsWith("-apple-darwin") ||
    triple.endsWith("-unknown-freebsd")
  ) {
    return null;
  }
  const arch = triple.startsWith("aarch64-") ? "arm64" : triple.startsWith("x86_64-") ? "x64" : null;
  const platform = triple.endsWith("-pc-windows-msvc") ? "windows" : "linux";
  if ((!triple.endsWith("-unknown-linux-gnu") && platform !== "windows") || !arch) {
    throw new Error(`Unsupported embedded runtime target: ${triple}`);
  }
  return { platform, arch };
}

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function stageWindowsRuntime(work, target, pin) {
  const key = `windows-${target.arch}`;
  const artifact = pin.artifacts[key];
  if (!artifact) {
    console.warn(`No pinned ${key} Bun runtime; local setup will require an updated app with a signed Windows runtime. Remote Gateways remain available.`);
    return false;
  }
  const download = async (name) => {
    const response = await fetch(`https://github.com/openclaw/bun/releases/download/${encodeURIComponent(pin.tag)}/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Bun ${name} download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  };
  const sums = (await download("SHA256SUMS")).toString("utf8").trim().split("\n");
  const checksum = (name) => {
    const matches = sums.map((line) => line.trim().split(/\s+/)).filter((parts) => parts[1] === name);
    assert.equal(matches.length, 1, `Missing or duplicate release checksum: ${name}`);
    return matches[0][0];
  };
  const manifestBytes = await download("manifest.json");
  assert.equal(digest(manifestBytes), checksum("manifest.json"), "Bun manifest sha256 mismatch");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.repository, "openclaw/bun", "Bun release repository mismatch");
  assert.equal(manifest.tag, pin.tag, "Bun release tag mismatch");
  assert.equal(manifest.bun.commit, pin.commit, "Bun release commit mismatch");
  assert.equal(manifest.bun.revision, pin.revision, "Bun release revision mismatch");
  const matches = manifest.assets.filter((asset) => asset.target === key);
  assert.equal(matches.length, 1, `Missing or duplicate Bun release target: ${key}`);
  const published = matches[0];
  assert.equal(published.os, "windows", "Bun release platform mismatch");
  assert.equal(published.arch, target.arch, "Bun release architecture mismatch");
  assert.equal(published.executable.authenticodeSigned, true, "Windows Bun must be Authenticode signed");
  assert.equal(published.executable.testOnly, false, "Test-only Windows Bun cannot be bundled");
  assert.deepEqual({
    asset: published.name, sha256: published.sha256, executable: published.executable.path,
    executableSha256: published.executable.sha256,
  }, artifact, "Bun release artifact differs from pin");
  assert.equal(checksum(artifact.asset), artifact.sha256, "Bun release archive sha256 mismatch");
  const archiveBytes = await download(artifact.asset);
  assert.equal(digest(archiveBytes), artifact.sha256, "Bun archive sha256 mismatch");
  const archive = path.join(work, "runtime.zip");
  const executablePath = path.join(work, "bin/bun.exe");
  fs.writeFileSync(archive, archiveBytes);
  fs.mkdirSync(path.dirname(executablePath));
  try {
    if (process.platform === "win32") {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [System.IO.Compression.ZipFile]::OpenRead($env:OPENCLAW_BUN_ARCHIVE)
        try {
          $entry = $zip.GetEntry($env:OPENCLAW_BUN_EXECUTABLE)
          if ($null -eq $entry) { throw 'Pinned Bun executable is missing' }
          [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $env:OPENCLAW_BUN_OUTPUT)
        } finally { $zip.Dispose() }
      `], { stdio: "inherit", env: { ...process.env, OPENCLAW_BUN_ARCHIVE: archive, OPENCLAW_BUN_EXECUTABLE: artifact.executable, OPENCLAW_BUN_OUTPUT: executablePath } });
    } else {
      const output = fs.openSync(executablePath, "wx");
      try {
        execFileSync("unzip", ["-p", archive, artifact.executable], { stdio: ["ignore", output, "inherit"] });
      } finally {
        fs.closeSync(output);
      }
    }
  } finally {
    fs.rmSync(archive);
  }
  const executable = fs.readFileSync(executablePath);
  assert.equal(digest(executable), artifact.executableSha256, "Bun executable checksum mismatch");
  assert.equal(executable.toString("ascii", 0, 2), "MZ", "Bun executable must be Windows PE");
  const pe = executable.readUInt32LE(0x3c);
  assert.equal(executable.readUInt32LE(pe), 0x4550, "Bun PE signature mismatch");
  assert.equal(executable.readUInt16LE(pe + 4), target.arch === "arm64" ? 0xaa64 : 0x8664, "Bun executable architecture mismatch");
  fs.writeFileSync(path.join(work, "manifest.json"), `${JSON.stringify({
    tag: pin.tag, commit: pin.commit, revision: pin.revision, ...target,
    authenticodeSigned: true, testOnly: false, files: { "bin/bun.exe": artifact.executableSha256 },
  }, null, 2)}\n`);
  return true;
}

export async function stageRuntime(triple) {
  const target = runtimeTarget(triple);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const work = fs.mkdtempSync(`${destination}-`);
  try {
    if (target?.platform === "windows") {
      const pin = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib/openclaw-bun.json"), "utf8"));
      if (!(await stageWindowsRuntime(work, target, pin))) fs.writeFileSync(path.join(work, "manifest.json"), "{}\n");
    } else if (target) {
      const pin = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib/openclaw-bun.json"), "utf8"));
      execFileSync(path.join(root, "scripts/stage-openclaw-bun.sh"), [work, target.platform, target.arch], {
        cwd: root,
        stdio: "inherit",
      });
      const executablePath = path.join(work, "bin/bun");
      const executable = fs.readFileSync(executablePath);
      fs.writeFileSync(executablePath, resourceBytes(executable));
      fs.chmodSync(executablePath, 0o644);
      const files = { "bin/bun": createHash("sha256").update(executable).digest("hex") };
      fs.writeFileSync(path.join(work, "manifest.json"), `${JSON.stringify({
        tag: pin.tag, commit: pin.commit, revision: pin.revision, ...target, files,
      }, null, 2)}\n`);
      fs.rmSync(path.join(work, "bun-manifest.json"));
    } else {
      fs.writeFileSync(path.join(work, "manifest.json"), "{}\n");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(work, destination);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = `${process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "linux" ? "unknown-linux-gnu" : process.platform === "win32" ? "pc-windows-msvc" : `unknown-${process.platform}`}`;
  await stageRuntime(process.env.TAURI_ENV_TARGET_TRIPLE || host);
}
