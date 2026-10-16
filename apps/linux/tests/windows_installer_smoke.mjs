import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyInstalledPayload(installDir, expectedManifestSha256) {
  const root = path.join(installDir, "desktop-runtime");
  const manifest = fs.readFileSync(path.join(root, "manifest.json"));
  assert.equal(sha256(manifest), expectedManifestSha256.toLowerCase(), "expected build manifest");
  const desktop = fs.readFileSync(path.join(installDir, "openclaw-desktop.exe"));
  // The desktop admission code embeds this exact manifest via include_str!.
  assert.ok(desktop.includes(manifest), "desktop must embed the installed runtime manifest");
  const { files, platform, arch, authenticodeSigned, testOnly, commit, revision } = JSON.parse(manifest);
  assert.equal(platform, "windows");
  assert.equal(arch, "x64");
  assert.equal(authenticodeSigned, true);
  assert.equal(testOnly, false);
  assert.match(commit, /^[0-9a-f]{40}$/);
  assert.ok(revision);

  // Release builds may contain just Bun. PR builds also stage a full package.
  // Walk the installed tree, not manifest paths, and require exactly the staged file set.
  const bunKey = "bin/bun.exe";
  const expected = new Map(Object.entries(files));
  assert.ok(expected.has(bunKey));
  for (const item of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (item.isDirectory()) continue;
    const file = path.join(item.parentPath, item.name);
    const key = path.relative(root, file).split(path.sep).join("/");
    assert.ok(item.isFile(), key);
    if (key === "manifest.json") continue;
    assert.equal(sha256(fs.readFileSync(file)), expected.get(key), key);
    expected.delete(key);
  }
  assert.equal(expected.size, 0, "installer omitted runtime files: " + [...expected.keys()].slice(0, 5));

  return { bun: path.join(root, bunKey), commit, revision };
}

function powershell(command, env) {
  return execFileSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
}

function qualifyInstaller() {
  // This runner is discarded after qualification. Never run the installer on a signing runner.
  const { CANDIDATE_DIR, RELEASE_TAG, EXPECTED_MANIFEST_SHA256, RUNNER_TEMP, GITHUB_OUTPUT } =
    process.env;
  const version = RELEASE_TAG.replace(/^v/, "");
  const [name, ...extra] = fs.readdirSync(CANDIDATE_DIR);
  assert.ok(name?.endsWith(".exe") && !extra.length, "expected exactly one installer");
  const installer = path.resolve(CANDIDATE_DIR, name);
  const installerDigest = sha256(fs.readFileSync(installer));
  const productVersion = powershell("(Get-Item -LiteralPath $env:INSTALLER).VersionInfo.ProductVersion", {
    INSTALLER: installer,
  });
  assert.equal(productVersion, version, "installer ProductVersion must match exactly");

  const installDir = fs.mkdtempSync(path.join(RUNNER_TEMP, "nsis-"));
  // NSIS requires /D= to be last and unquoted, even with spaces. /NS skips shortcuts.
  execFileSync(installer, ["/S", "/NS", "/D=" + installDir], {
    windowsVerbatimArguments: true,
    timeout: 8 * 60_000,
    stdio: "inherit",
  });

  const { bun, commit, revision } = verifyInstalledPayload(installDir, EXPECTED_MANIFEST_SHA256);
  powershell(
    `$s = Get-AuthenticodeSignature -LiteralPath $env:INSTALLED_BUN
    if ($s.Status -ne 'Valid' -or -not $s.TimeStamperCertificate -or
        $s.SignerCertificate.Subject -cne 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US') {
      throw "Expected valid, timestamped Foundation signature on installed Bun, got $($s.Status)"
    }`,
    { INSTALLED_BUN: bun },
  );
  function probe(args) {
    return execFileSync(bun, args, { encoding: "utf8", timeout: 60_000, cwd: installDir }).trim();
  }
  assert.equal(probe(["--revision"]), revision, "installed Bun revision");
  assert.equal(probe(["-p", "Bun.revision"]), commit, "installed Bun fork commit");

  assert.equal(sha256(fs.readFileSync(installer)), installerDigest, "installer changed during test");
  console.log("Qualified", name, "version", version, "sha256", installerDigest);
  fs.appendFileSync(GITHUB_OUTPUT, "sha256=" + installerDigest + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  qualifyInstaller();
}
