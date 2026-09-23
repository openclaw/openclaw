import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const baselineVersion = "2026.9.4";
const baselineCommit = "3a9d69db306cd7f081e06254cb89c4bcc14a7107";
const baselineUrl = "https://registry.npmjs.org/openclaw/-/openclaw-2026.9.4.tgz";
const baselineIntegrity =
  "sha512-lTQpEEe1Xm3u2PCHaPEr+vP8paGk1vLdHuzdItsNToaLI6hAqRVvgJYg+GxukJhETJp4tPy/S1Gftl4KuB8n7A==";

function hash(bytes, algorithm = "sha256", encoding = "hex") {
  return createHash(algorithm).update(bytes).digest(encoding);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// npm owns dependency reification. Compare the immutable application payload,
// including its complete dist inventory, separately from installed node_modules.
export function readWorkerCellPackageIdentity(packageRoot) {
  const files = {};
  const visit = (relative) => {
    const file = path.join(packageRoot, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      files[relative] = { symlink: fs.readlinkSync(file) };
    } else if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).toSorted((a, b) => a.localeCompare(b))) {
        visit(path.posix.join(relative, name));
      }
    } else {
      assert(stat.isFile(), `Unsupported package entry: ${relative}`);
      files[relative] = { sha256: hash(fs.readFileSync(file)), size: stat.size };
    }
  };
  for (const relative of ["package.json", "openclaw.mjs", "dist"]) {
    visit(relative);
  }
  const manifest = readJson(path.join(packageRoot, "package.json"));
  assert.equal(manifest.name, "openclaw");
  const buildInfo = readJson(path.join(packageRoot, "dist/build-info.json"));
  assert.equal(buildInfo.version, manifest.version);
  assert.match(buildInfo.commit, /^[a-f0-9]{40}$/u);
  return { version: manifest.version, buildInfo, files };
}

export function assertWorkerCellPackageIdentity(actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    "Installed application payload differs from the frozen tarball",
  );
}

export function resolveWorkerCellExport(source, name) {
  const matches = [];
  for (const block of source.matchAll(/export\s*\{([^}]+)\}\s*;/gu)) {
    for (const specifier of block[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/u);
      if (parts[0] === name && parts.length <= 2) {
        matches.push(parts[1] ?? parts[0]);
      }
    }
  }
  assert(matches.length <= 1, `Ambiguous compiled export ${name}`);
  return matches[0];
}

/** Generated forwarding entries can share the defining owner's filename prefix. */
export function resolveWorkerCellFunctionBinding(identity, packageRoot, prefix, symbol, ts) {
  const root = fs.realpathSync(packageRoot);
  const matches = [];
  for (const relative of Object.keys(identity.files)) {
    const name = path.posix.basename(relative);
    if (
      path.posix.dirname(relative) !== "dist" ||
      !name.startsWith(`${prefix}-`) ||
      !name.endsWith(".mjs")
    ) {
      continue;
    }
    const file = path.join(root, relative);
    assert.equal(fs.realpathSync(file), file, `Owner must be a regular package path: ${relative}`);
    assert(fs.lstatSync(file).isFile());
    const bytes = fs.readFileSync(file);
    const expectedHash = identity.files[relative].sha256;
    assert.equal(hash(bytes), expectedHash, `Package owner changed: ${relative}`);
    const source = bytes.toString("utf8");
    const ast = ts.createSourceFile(
      relative,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    assert.equal(ast.parseDiagnostics.length, 0, `Cannot parse package owner: ${relative}`);
    const definitions = ast.statements.filter(
      (entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === symbol && entry.body,
    );
    if (definitions.length === 0) {
      continue;
    }
    assert.equal(definitions.length, 1, `Ambiguous local definition: ${symbol}`);
    if (resolveWorkerCellExport(source, symbol)) {
      matches.push([name, symbol, expectedHash]);
    }
  }
  assert.equal(matches.length, 1, `Expected one installed defining ${prefix} owner`);
  return matches[0];
}

function inspectTarball(tarball, runtimeRoot) {
  const bytes = fs.readFileSync(tarball);
  const sha256 = hash(bytes);
  const integrity = `sha512-${hash(bytes, "sha512", "base64")}`;
  const scratch = fs.mkdtempSync(path.join(runtimeRoot, "package-identity-"));
  try {
    execFileSync(
      "tar",
      [
        "-xzf",
        tarball,
        "-C",
        scratch,
        "package/package.json",
        "package/openclaw.mjs",
        "package/dist",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return { sha256, integrity, ...readWorkerCellPackageIdentity(path.join(scratch, "package")) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, packageRoot, candidateTarball] = process.argv.slice(2);
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
  assert(artifacts && runtimeRoot && packageRoot, "Missing isolated worker-cell paths");
  if (mode === "baseline") {
    const response = await fetch(baselineUrl);
    assert(response.ok, `Published baseline download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(`sha512-${hash(bytes, "sha512", "base64")}`, baselineIntegrity);
    const tarball = path.join(runtimeRoot, "published-driver.tgz");
    fs.writeFileSync(tarball, bytes, { flag: "wx" });
    const expected = inspectTarball(tarball, runtimeRoot);
    assert.equal(expected.version, baselineVersion);
    assert.equal(expected.buildInfo.commit, baselineCommit);
    const actual = readWorkerCellPackageIdentity(packageRoot);
    assertWorkerCellPackageIdentity(actual, {
      version: expected.version,
      buildInfo: expected.buildInfo,
      files: expected.files,
    });
    writeJson(path.join(artifacts, "baseline-package-identity.json"), {
      url: baselineUrl,
      cli: fs.realpathSync(path.join(packageRoot, "openclaw.mjs")),
      ...expected,
    });
  } else if (mode === "candidate") {
    assert(candidateTarball, "Missing frozen candidate tarball");
    const expected = inspectTarball(candidateTarball, runtimeRoot);
    assert.equal(
      expected.buildInfo.commit,
      process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
      "Candidate build commit must equal the selected source SHA",
    );
    assert.notEqual(
      expected.buildInfo.commit,
      baselineCommit,
      "Candidate still contains published bytes",
    );
    writeJson(path.join(artifacts, "candidate-package-identity.json"), expected);
  } else if (mode === "installed") {
    const expected = readJson(path.join(artifacts, "candidate-package-identity.json"));
    assert.equal(
      hash(fs.readFileSync(candidateTarball)),
      expected.sha256,
      "Candidate tarball changed",
    );
    const actual = readWorkerCellPackageIdentity(packageRoot);
    assertWorkerCellPackageIdentity(actual, {
      version: expected.version,
      buildInfo: expected.buildInfo,
      files: expected.files,
    });
    writeJson(path.join(artifacts, "installed-package-identity.json"), {
      cli: fs.realpathSync(path.join(packageRoot, "openclaw.mjs")),
      ...actual,
    });
  } else {
    throw new Error("Expected baseline, candidate, or installed package-identity mode");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
