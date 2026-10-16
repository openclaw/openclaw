import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeStandaloneRuntime, sha256File } from "./bun-standalone-contract.mjs";

const bunPin = JSON.parse(fs.readFileSync(new URL("./openclaw-bun.json", import.meta.url), "utf8"));

export function readMacStandaloneManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.schemaVersion, 1, "Unsupported standalone manifest version");
  assert(["jit", "bytecode"].includes(manifest.mode), "Unsupported Mac standalone mode");
  assert.equal(manifest.target?.platform, "darwin", "Standalone platform mismatch");
  assert(["arm64", "x64"].includes(manifest.target.arch), "Standalone architecture mismatch");
  for (const field of ["revision", "commit"]) {
    assert.equal(manifest.bun?.[field], bunPin[field], `Standalone Bun ${field} mismatch`);
  }
  assert.equal(
    manifest.bun?.executableSha256,
    bunPin.artifacts[`darwin-${manifest.target.arch}`].executableSha256,
    "Standalone Bun executableSha256 mismatch",
  );
  assert.equal(manifest.executable?.path, "openclaw", "Standalone executable path mismatch");
  assert.equal(manifest.runtime?.path, "runtime", "Standalone sidecar path mismatch");
  assert.equal(manifest.macos?.hardenedRuntime, true, "Standalone hardened runtime mismatch");
  assert.deepEqual(
    manifest.macos.entitlements,
    {
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.disable-library-validation": true,
    },
    "Unexpected standalone macOS entitlements",
  );
  return manifest;
}

export async function verifyMacStandaloneRuntime(root, expected, mode, arch, pluginIds) {
  const manifest = readMacStandaloneManifest(root);
  assert.match(expected.commit, /^[a-f\d]{40}$/u, "App commit must be an exact source SHA");
  assert.equal(manifest.openclaw?.commit, expected.commit, "Standalone OpenClaw commit mismatch");
  assert.equal(
    manifest.openclaw?.version,
    expected.version,
    "Standalone OpenClaw version mismatch",
  );
  assert.equal(manifest.mode, mode, "Standalone mode mismatch");
  assert.equal(
    manifest.target.arch,
    arch === "x86_64" ? "x64" : arch,
    "Standalone architecture mismatch",
  );
  if (pluginIds !== undefined) {
    assert.deepEqual(
      manifest.plugins?.embedded,
      pluginIds,
      "Standalone desktop plugin selection mismatch",
    );
  }
  assert(
    fs.lstatSync(path.join(root, "runtime")).isDirectory(),
    "Standalone sidecar must be a directory",
  );
  const executable = path.join(root, "openclaw");
  assert(fs.lstatSync(executable).isFile(), "Standalone executable must be a regular file");
  assert.equal(
    await sha256File(executable),
    manifest.executable.sha256,
    "Standalone executable SHA256 mismatch",
  );
  assert.equal(
    fs.statSync(executable).size,
    manifest.executable.sizeBytes,
    "Standalone executable size mismatch",
  );
  const actual = await describeStandaloneRuntime(path.join(root, "runtime"));
  for (const key of ["sha256", "sizeBytes", "fileCount", "symlinkCount"]) {
    assert.equal(actual[key], manifest.runtime[key], `Standalone runtime ${key} mismatch`);
  }
  assert(
    fs
      .lstatSync(path.join(root, "runtime/lib/libsqlite3.dylib"), { throwIfNoEntry: false })
      ?.isFile(),
    "Standalone bundled SQLite is missing; rebuild the complete standalone artifact",
  );
  return manifest;
}

export async function refreshMacStandaloneManifest(root, installOwner = false) {
  const manifest = readMacStandaloneManifest(root);
  if (installOwner) {
    fs.writeFileSync(
      path.join(root, "runtime/openclaw-install-owner.json"),
      JSON.stringify({
        schemaVersion: 1,
        owner: "macos-app",
        displayName: "OpenClaw.app",
        updateHint: "Update OpenClaw.app to update this Gateway.",
      }) + "\n",
    );
  }
  const executable = path.join(root, "openclaw");
  manifest.executable = {
    path: "openclaw",
    sizeBytes: fs.statSync(executable).size,
    sha256: await sha256File(executable),
  };
  // Keep the builder's resource breakdown and provenance when resealing staged bytes.
  manifest.runtime = {
    ...manifest.runtime,
    ...(await describeStandaloneRuntime(path.join(root, "runtime"))),
  };
  if (manifest.runtime.sqlite) {
    manifest.runtime.sqlite.sha256 = await sha256File(
      path.join(root, "runtime/lib/libsqlite3.dylib"),
    );
  }
  if (installOwner) {
    // Hash the complete unsigned payload, including the app-owned additions.
    // Resealing updates native hashes without changing this seed identity.
    manifest.buildId = createHash("sha256")
      .update(
        JSON.stringify([
          manifest.openclaw,
          manifest.mode,
          manifest.executable.sha256,
          manifest.runtime.sha256,
        ]),
      )
      .digest("hex");
  }
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function writeEntitlements(root, destination) {
  const { macos } = readMacStandaloneManifest(root);
  const entries = Object.entries(macos.entitlements)
    .map(([key, value]) => `<key>${key}</key><${value}/>`)
    .join("\n");
  fs.writeFileSync(
    destination,
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${entries}\n</dict></plist>\n`,
  );
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, root, ...args] = process.argv.slice(2);
  if (operation === "verify") {
    const [buildInfo, mode, arch, pluginIds] = args;
    await verifyMacStandaloneRuntime(
      root,
      JSON.parse(fs.readFileSync(buildInfo, "utf8")),
      mode,
      arch,
      pluginIds?.split(","),
    );
  } else if (operation === "stage") {
    await refreshMacStandaloneManifest(root, true);
  } else if (operation === "seal") {
    await refreshMacStandaloneManifest(root);
  } else if (operation === "entitlements") {
    writeEntitlements(root, args[0]);
  } else {
    throw new Error(
      "Usage: mac-standalone-runtime.mjs <verify|stage|seal|entitlements> <runtime-root> [arguments]",
    );
  }
}
