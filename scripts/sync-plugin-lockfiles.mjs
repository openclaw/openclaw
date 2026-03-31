/**
 * Regenerates package-lock.json for every bundled plugin that declares
 * `openclaw.bundle.stageRuntimeDependencies: true`.
 *
 * The committed lockfiles are used at build time by
 * stage-bundled-plugin-runtime-deps.mjs so that transitive dependency
 * resolution is deterministic and auditable.
 *
 * Usage:
 *   node scripts/sync-plugin-lockfiles.mjs          # regenerate all
 *   node scripts/sync-plugin-lockfiles.mjs --check   # verify lockfiles are up-to-date
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNpmRunner } from "./stage-bundled-plugin-runtime-deps.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listPluginDirsWithStagedRuntimeDeps() {
  const extensionsRoot = path.join(REPO_ROOT, "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return [];
  }
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(extensionsRoot, d.name))
    .filter((dir) => {
      const pkgPath = path.join(dir, "package.json");
      if (!fs.existsSync(pkgPath)) {
        return false;
      }
      const pkg = readJson(pkgPath);
      return pkg.openclaw?.bundle?.stageRuntimeDependencies === true;
    });
}

/** Build a sanitized package.json matching the build-time transform. */
function sanitizeForInstall(packageJson) {
  const pkg = { ...packageJson };

  // Remove openclaw from peerDependencies
  if (pkg.peerDependencies?.openclaw) {
    const next = { ...pkg.peerDependencies };
    delete next.openclaw;
    pkg.peerDependencies = Object.keys(next).length > 0 ? next : undefined;
  }
  if (pkg.peerDependenciesMeta?.openclaw) {
    const next = { ...pkg.peerDependenciesMeta };
    delete next.openclaw;
    pkg.peerDependenciesMeta = Object.keys(next).length > 0 ? next : undefined;
  }
  // Remove openclaw from devDependencies
  if (pkg.devDependencies?.openclaw) {
    const next = { ...pkg.devDependencies };
    delete next.openclaw;
    pkg.devDependencies = Object.keys(next).length > 0 ? next : undefined;
  }

  // Clean undefined keys
  for (const key of Object.keys(pkg)) {
    if (pkg[key] === undefined) {
      delete pkg[key];
    }
  }

  return pkg;
}

function generateLockfile(pluginDir) {
  const pluginId = path.basename(pluginDir);
  const packageJson = readJson(path.join(pluginDir, "package.json"));
  const sanitized = sanitizeForInstall(packageJson);

  const tmpDir = fs.mkdtempSync(path.join(pluginDir, ".lockfile-gen-"));
  try {
    writeJson(path.join(tmpDir, "package.json"), sanitized);

    const npmRunner = resolveNpmRunner({
      npmArgs: [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--package-lock",
      ],
    });

    const result = spawnSync(npmRunner.command, npmRunner.args, {
      cwd: tmpDir,
      encoding: "utf8",
      env: npmRunner.env,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });

    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(`npm install failed for ${pluginId}: ${output}`);
    }

    const generatedLockfile = path.join(tmpDir, "package-lock.json");
    if (!fs.existsSync(generatedLockfile)) {
      throw new Error(`no package-lock.json produced for ${pluginId}`);
    }

    const destLockfile = path.join(pluginDir, "package-lock.json");
    fs.copyFileSync(generatedLockfile, destLockfile);
    return destLockfile;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function checkLockfileUpToDate(pluginDir) {
  const pluginId = path.basename(pluginDir);
  const existingLockfilePath = path.join(pluginDir, "package-lock.json");

  if (!fs.existsSync(existingLockfilePath)) {
    return { pluginId, ok: false, reason: "missing" };
  }

  // Verify the committed lockfile's dependency ranges still match the current
  // package.json by comparing the packages.\"\" entry (the root project spec)
  // in the existing lockfile against the sanitized package.json.
  const packageJson = readJson(path.join(pluginDir, "package.json"));
  const sanitized = sanitizeForInstall(packageJson);
  const existingLock = readJson(existingLockfilePath);

  const lockRootDeps = existingLock.packages?.[""]?.dependencies ?? {};
  const manifestDeps = sanitized.dependencies ?? {};

  // Check that every declared dependency appears in the lockfile root with
  // a matching version range. This catches outdated lockfiles after dep bumps.
  for (const [name, range] of Object.entries(manifestDeps)) {
    if (lockRootDeps[name] !== range) {
      const lockValue = name in lockRootDeps ? lockRootDeps[name] : "(missing)";
      return {
        pluginId,
        ok: false,
        reason:
          "dependency " +
          name +
          " mismatch: package.json has " +
          JSON.stringify(range) +
          ", lockfile has " +
          JSON.stringify(lockValue),
      };
    }
  }

  // Check for deps that were removed from package.json but remain in lockfile root
  for (const name of Object.keys(lockRootDeps)) {
    if (!(name in manifestDeps)) {
      return {
        pluginId,
        ok: false,
        reason: `dependency ${name} in lockfile but not in package.json`,
      };
    }
  }

  return { pluginId, ok: true, reason: "ok" };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const isCheck = process.argv.includes("--check");
  const pluginDirs = listPluginDirsWithStagedRuntimeDeps();

  if (pluginDirs.length === 0) {
    console.log("No plugins with stageRuntimeDependencies found.");
    process.exit(0);
  }

  if (isCheck) {
    let allOk = true;
    for (const dir of pluginDirs) {
      const result = checkLockfileUpToDate(dir);
      if (result.ok) {
        console.log(`  ✓ ${result.pluginId}`);
      } else {
        console.log(`  ✗ ${result.pluginId} (${result.reason})`);
        allOk = false;
      }
    }
    if (!allOk) {
      console.error("\nPlugin lockfiles are out of date. Run: pnpm plugin-lockfiles:sync");
      process.exit(1);
    }
    console.log("\nAll plugin lockfiles are up to date.");
  } else {
    for (const dir of pluginDirs) {
      const pluginId = path.basename(dir);
      process.stdout.write(`  ${pluginId}...`);
      generateLockfile(dir);
      process.stdout.write(" ✓\n");
    }
    console.log("\nPlugin lockfiles regenerated.");
  }
}
