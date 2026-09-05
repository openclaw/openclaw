import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  let allowPreNativeContract = false;
  let packageRoot;
  let mode;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--allow-pre-native-contract") {
      if (value !== "0" && value !== "1") {
        throw new Error("--allow-pre-native-contract must be 0 or 1");
      }
      allowPreNativeContract = value === "1";
    } else if (key === "--package-root") {
      packageRoot = value;
    } else if (key === "--mode") {
      mode = value;
    } else {
      throw new Error(`unknown argument: ${key ?? ""}`);
    }
  }
  if (!packageRoot || (mode !== "require" && mode !== "fallback")) {
    throw new Error(
      "usage: verify-fs-safe-native.mjs --package-root <path> --mode <require|fallback> [--allow-pre-native-contract <0|1>]",
    );
  }
  return { allowPreNativeContract, mode, packageRoot: path.resolve(packageRoot) };
}

function nativeGeneration(version) {
  assert.equal(typeof version, "string", "expected @openclaw/fs-safe to declare a version");
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  assert.ok(match, "expected @openclaw/fs-safe to declare a stable semantic version");
  const [major, minor, patch] = match.slice(1).map(Number);
  assert.ok(
    [major, minor, patch].every(Number.isSafeInteger),
    "expected @openclaw/fs-safe version components to be safe integers",
  );
  return major > 0 || minor >= 6 ? "split" : minor === 5 ? "bundled" : "pre";
}

function findOwningPackage(resolvedPath, expectedName) {
  let current = fs.realpathSync(path.dirname(resolvedPath));
  while (true) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === expectedName) {
        return { manifest, manifestPath, root: current };
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`could not find the installed ${expectedName} package`);
    }
    current = parent;
  }
}

function hasPhysicalPackageEntry(packageRoot, packageName) {
  const packageSegments = packageName.split("/");
  let current = packageRoot;
  while (true) {
    if (path.basename(current) !== "node_modules") {
      const candidate = path.join(current, "node_modules", ...packageSegments);
      try {
        fs.lstatSync(candidate);
        return true;
      } catch (error) {
        if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
          throw error;
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return false;
    }
    current = parent;
  }
}

const { allowPreNativeContract, mode, packageRoot } = parseArgs(process.argv.slice(2));
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const configPath = requireFromPackage.resolve("@openclaw/fs-safe/config");
const {
  manifest: fsSafeManifest,
  manifestPath: fsSafeManifestPath,
  root: fsSafeRoot,
} = findOwningPackage(configPath, "@openclaw/fs-safe");
assert.equal(fsSafeManifest.name, "@openclaw/fs-safe", "resolved an unexpected fs-safe package");
const fsSafeExports = fsSafeManifest.exports;
assert.ok(
  fsSafeExports !== null && typeof fsSafeExports === "object" && !Array.isArray(fsSafeExports),
  "expected @openclaw/fs-safe package exports",
);
assert.ok(
  Object.hasOwn(fsSafeExports, "./config"),
  "expected @openclaw/fs-safe to export ./config",
);
const optionalDependencies = fsSafeManifest.optionalDependencies;
assert.ok(
  optionalDependencies === undefined ||
    (optionalDependencies !== null &&
      typeof optionalDependencies === "object" &&
      !Array.isArray(optionalDependencies)),
  "expected @openclaw/fs-safe optionalDependencies to be an object",
);
const generation = nativeGeneration(fsSafeManifest.version);
const fsSafeConfig = await import(pathToFileURL(configPath).href);
const platformPackageNames = Object.keys(optionalDependencies ?? {}).filter((name) =>
  name.startsWith("@openclaw/fs-safe-"),
);
const hasDurabilityExport = Object.hasOwn(fsSafeExports, "./durability");
const hasNativeConfiguration = typeof fsSafeConfig.configureFsSafeNative === "function";
if (!hasNativeConfiguration) {
  assert.ok(
    allowPreNativeContract,
    "pre-native @openclaw/fs-safe requires explicit frozen-target authorization",
  );
  assert.equal(generation, "pre", "expected native configuration for @openclaw/fs-safe >= 0.5.0");
  assert.equal(
    platformPackageNames.length,
    0,
    "pre-native fs-safe unexpectedly declares platform packages",
  );
  assert.equal(
    fs.existsSync(path.join(fsSafeRoot, "dist", "native")),
    false,
    "pre-native fs-safe unexpectedly contains bundled native bindings",
  );
  console.log("Skipping fs-safe native proof: authorized package predates native bindings.");
  process.exit(0);
}

assert.notEqual(
  generation,
  "pre",
  "fs-safe native configuration predates the bundled-native contract",
);
assert.ok(hasDurabilityExport, "expected native-capable @openclaw/fs-safe to export ./durability");

const splitNative = generation === "split";
assert.equal(
  platformPackageNames.length > 0,
  splitNative,
  splitNative
    ? "expected @openclaw/fs-safe >= 0.6.0 to declare platform packages"
    : "fs-safe platform packages predate the split-native contract",
);

const requireFromFsSafe = createRequire(fsSafeManifestPath);
const installedPlatformPackages = platformPackageNames.flatMap((name) => {
  assert.equal(
    optionalDependencies[name],
    fsSafeManifest.version,
    `expected ${name} dependency to match @openclaw/fs-safe exactly`,
  );
  try {
    const manifestPath = requireFromFsSafe.resolve(`${name}/package.json`);
    const platformPackage = findOwningPackage(manifestPath, name);
    assert.equal(
      platformPackage.manifest.version,
      fsSafeManifest.version,
      `expected installed ${name} version to match @openclaw/fs-safe`,
    );
    return [{ name, root: platformPackage.root }];
  } catch (error) {
    if (error?.code === "MODULE_NOT_FOUND" && !hasPhysicalPackageEntry(fsSafeRoot, name)) {
      return [];
    }
    throw error;
  }
});

const durabilityPath = requireFromPackage.resolve("@openclaw/fs-safe/durability");
const { configureFsSafeNative } = fsSafeConfig;
const { sha256File } = await import(pathToFileURL(durabilityPath).href);
configureFsSafeNative({ mode: mode === "require" ? "require" : "off" });

const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-safe-proof-"));
try {
  const fixture = path.join(temporaryRoot, "fixture.txt");
  await fsPromises.writeFile(fixture, "fs-safe native package proof");
  const result = await sha256File(fixture);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);

  const loadedNativeModules = Object.keys(requireFromPackage.cache).filter((file) =>
    file.endsWith("fs-safe-native.node"),
  );
  if (mode === "require") {
    assert.equal(
      loadedNativeModules.length,
      1,
      "expected exactly one loaded fs-safe native binding",
    );
    const loadedNativePath = fs.realpathSync(loadedNativeModules[0]);
    if (splitNative) {
      assert.ok(
        installedPlatformPackages.length > 0,
        "expected at least one fs-safe platform package",
      );
      const loadedNativeRoot = path.dirname(loadedNativePath);
      assert.ok(
        installedPlatformPackages.some(({ root }) => root === loadedNativeRoot),
        "loaded fs-safe native binding did not come from an installed platform package",
      );
    } else {
      const relativeBinding = path.relative(fsSafeRoot, loadedNativePath);
      assert.match(
        relativeBinding,
        /^dist[\\/]native[\\/][^\\/]+[\\/]fs-safe-native\.node$/u,
        "loaded bundled fs-safe native binding escaped dist/native/<target>",
      );
    }
  } else {
    assert.equal(
      installedPlatformPackages.length,
      0,
      "fallback install contains a platform package",
    );
    assert.equal(loadedNativeModules.length, 0, "fallback loaded an fs-safe native binding");
  }
} finally {
  await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
}
