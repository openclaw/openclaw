import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
export async function resolveWorkerCellFunctionBinding(
  identity,
  packageRoot,
  prefix,
  symbol,
  parser,
) {
  const ts = await import("typescript/unstable/ast");
  const root = fs.realpathSync(packageRoot);
  const sources = [];
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
    sources.push({ fileName: file, text: bytes.toString("utf8"), name, expectedHash });
  }
  const sourceFiles = parser.parseSourceFiles(sources);
  const resolveFunctionExport = (sourceFile) => {
    assert.equal(
      parser.getSyntacticDiagnostics(sourceFile.fileName).length,
      0,
      `Cannot parse package owner: ${sourceFile.fileName}`,
    );
    const definitions = sourceFile.statements.filter(
      (entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === symbol && entry.body,
    );
    if (definitions.length === 0) {
      return undefined;
    }
    assert.equal(definitions.length, 1, `Ambiguous local definition: ${symbol}`);
    return resolveWorkerCellExport(sourceFile.text, symbol);
  };
  const matches = [];
  for (const [index, sourceFile] of sourceFiles.entries()) {
    if (resolveFunctionExport(sourceFile)) {
      const { name, expectedHash } = sources[index];
      matches.push([name, symbol, expectedHash]);
    }
  }
  assert.equal(matches.length, 1, `Expected one installed defining ${prefix} owner`);
  return matches[0];
}

function inspectTarball(bytes, runtimeRoot) {
  const sha256 = hash(bytes);
  const integrity = `sha512-${hash(bytes, "sha512", "base64")}`;
  const scratch = fs.mkdtempSync(path.join(runtimeRoot, "package-identity-"));
  try {
    execFileSync(
      "tar",
      ["-xzf", "-", "-C", scratch, "package/package.json", "package/openclaw.mjs", "package/dist"],
      { input: bytes, stdio: ["pipe", "pipe", "pipe"] },
    );
    return { sha256, integrity, ...readWorkerCellPackageIdentity(path.join(scratch, "package")) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function main() {
  const [mode, packageRoot, argument] = process.argv.slice(2);
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const runtimeRoot = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
  assert(artifacts && runtimeRoot && packageRoot, "Missing isolated worker-cell paths");
  if (mode === "baseline") {
    // Installation already resolved tags and admitted the requested version.
    // Pin that version here before scenario setup can change published bytes.
    const version = argument;
    assert(version, "Missing admitted baseline version");
    assert.equal(readJson(path.join(packageRoot, "package.json")).version, version);
    const metadataResponse = await fetch(
      `https://registry.npmjs.org/openclaw/${encodeURIComponent(version)}`,
    );
    assert(metadataResponse.ok, `Published baseline metadata failed: ${metadataResponse.status}`);
    const published = await metadataResponse.json();
    assert.equal(published.name, "openclaw");
    assert.equal(published.version, version);
    const response = await fetch(published.dist.tarball);
    assert(response.ok, `Published baseline download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(
      `sha512-${hash(bytes, "sha512", "base64")}`,
      published.dist.integrity,
      "Published baseline integrity mismatch",
    );
    const expected = inspectTarball(bytes, runtimeRoot);
    assert.equal(expected.version, version);
    const actual = readWorkerCellPackageIdentity(packageRoot);
    assertWorkerCellPackageIdentity(actual, {
      version: expected.version,
      buildInfo: expected.buildInfo,
      files: expected.files,
    });
    writeJson(path.join(artifacts, "baseline-package-identity.json"), {
      url: published.dist.tarball,
      cli: fs.realpathSync(path.join(packageRoot, "openclaw.mjs")),
      ...expected,
    });
  } else if (mode === "candidate") {
    const candidateTarball = argument;
    assert(candidateTarball, "Missing frozen candidate tarball");
    const expected = inspectTarball(fs.readFileSync(candidateTarball), runtimeRoot);
    assert.match(expected.buildInfo.commit, /^[a-f0-9]{40}$/u);
    assert.equal(
      expected.buildInfo.commit,
      process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA,
      "Candidate build commit must equal the selected source SHA",
    );
    const baseline = readJson(path.join(artifacts, "baseline-package-identity.json"));
    assert.notEqual(
      expected.buildInfo.commit,
      baseline.buildInfo.commit,
      "Candidate still contains published bytes",
    );
    writeJson(path.join(artifacts, "candidate-package-identity.json"), expected);
  } else if (mode === "installed") {
    const candidateTarball = argument;
    const expected = readJson(path.join(artifacts, "candidate-package-identity.json"));
    let tarballBytes;
    try {
      tarballBytes = fs.readFileSync(candidateTarball);
    } catch (cause) {
      throw new Error("Candidate tarball changed: cannot read the frozen tarball", { cause });
    }
    assert.equal(hash(tarballBytes), expected.sha256, "Candidate tarball changed");
    let actual;
    try {
      actual = readWorkerCellPackageIdentity(packageRoot);
    } catch (cause) {
      throw new Error(
        "Installed application payload differs from the frozen tarball: cannot read the installed package",
        { cause },
      );
    }
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
