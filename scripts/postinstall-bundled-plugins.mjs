#!/usr/bin/env node
// Runs after install to restore bundled extension runtime deps.
// Installed builds can lazy-load bundled plugin code through root dist chunks,
// so runtime dependencies declared in dist/extensions/*/package.json must also
// resolve from the package root node_modules. Skip source checkouts.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNpmRunner } from "./npm-runner.mjs";

export const BUNDLED_PLUGIN_INSTALL_TARGETS = [];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSIONS_DIR = join(__dirname, "..", "dist", "extensions");
const DEFAULT_PACKAGE_ROOT = join(__dirname, "..");
const DISABLE_POSTINSTALL_ENV = "OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL";

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function dependencySentinelPath(depName) {
  return join("node_modules", ...depName.split("/"), "package.json");
}

function collectRuntimeDeps(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
}

export function discoverBundledPluginRuntimeDeps(params = {}) {
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const readJsonFile = params.readJson ?? readJson;
  const deps = new Map(
    BUNDLED_PLUGIN_INSTALL_TARGETS.map((target) => [
      target.name,
      {
        name: target.name,
        version: target.version,
        sentinelPath: dependencySentinelPath(target.name),
        pluginIds: [...(target.pluginIds ?? [])],
      },
    ]),
  );

  if (!pathExists(extensionsDir)) {
    return [...deps.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  for (const entry of readDir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const packageJsonPath = join(extensionsDir, pluginId, "package.json");
    if (!pathExists(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = readJsonFile(packageJsonPath);
      for (const [name, version] of Object.entries(collectRuntimeDeps(packageJson))) {
        const existing = deps.get(name);
        if (existing) {
          if (existing.version !== version) {
            continue;
          }
          if (!existing.pluginIds.includes(pluginId)) {
            existing.pluginIds.push(pluginId);
          }
          continue;
        }
        deps.set(name, {
          name,
          version,
          sentinelPath: dependencySentinelPath(name),
          pluginIds: [pluginId],
        });
      }
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  return [...deps.values()]
    .map((dep) => ({
      ...dep,
      pluginIds: [...dep.pluginIds].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
}

function isSourceCheckoutRoot(params) {
  const pathExists = params.existsSync ?? existsSync;
  return (
    pathExists(join(params.packageRoot, ".git")) &&
    pathExists(join(params.packageRoot, "src")) &&
    pathExists(join(params.packageRoot, "extensions"))
  );
}

function shouldRunBundledPluginPostinstall(params) {
  if (params.env?.[DISABLE_POSTINSTALL_ENV]?.trim()) {
    return false;
  }
  if (!params.existsSync(params.extensionsDir)) {
    return false;
  }
  if (isSourceCheckoutRoot({ packageRoot: params.packageRoot, existsSync: params.existsSync })) {
    return false;
  }
  return true;
}

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const spawn = params.spawnSync ?? spawnSync;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  if (
    !shouldRunBundledPluginPostinstall({
      env,
      extensionsDir,
      packageRoot,
      existsSync: pathExists,
    })
  ) {
    return;
  }
  const runtimeDeps =
    params.runtimeDeps ??
    discoverBundledPluginRuntimeDeps({ extensionsDir, existsSync: pathExists });
  const missingSpecs = runtimeDeps
    .filter((dep) => !pathExists(join(packageRoot, dep.sentinelPath)))
    .map((dep) => `${dep.name}@${dep.version}`);

  if (missingSpecs.length === 0) {
    return;
  }

  try {
    const nestedEnv = createNestedNpmInstallEnv(env);
    const npmRunner =
      params.npmRunner ??
      resolveNpmRunner({
        env: nestedEnv,
        execPath: params.execPath,
        existsSync: pathExists,
        platform: params.platform,
        comSpec: params.comSpec,
        npmArgs: ["install", "--omit=dev", "--no-save", "--package-lock=false", ...missingSpecs],
      });
    const result = spawn(npmRunner.command, npmRunner.args, {
      cwd: packageRoot,
      encoding: "utf8",
      env: npmRunner.env ?? nestedEnv,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(output || "npm install failed");
    }
    log.log(`[postinstall] installed bundled plugin deps: ${missingSpecs.join(", ")}`);
  } catch (e) {
    // Non-fatal: gateway will surface the missing dep via doctor.
    log.warn(`[postinstall] could not install bundled plugin deps: ${String(e)}`);
  }
}

// Patches for third-party dependencies that fix bugs or improve behavior.
function applyDependencyPatches(params = {}) {
  const pathExists = params.existsSync ?? existsSync;
  const readFile = params.readFileSync ?? readFileSync;
  const writeFile = params.writeFileSync ?? writeFileSync;
  const log = params.log ?? console;

  const ROOT = params.root ?? DEFAULT_PACKAGE_ROOT;

  // Patch pi-coding-agent's edit-diff.js to improve error messages when fuzzy matching is used.
  // Issue: edit tool requires exact text match causing memory write failures
  // The edit tool has fuzzy matching but error messages say "exact text" even when fuzzy was used.
  const EDIT_DIFF_PATH = join(
    ROOT,
    "node_modules/@mariozechner/pi-coding-agent/dist/core/tools/edit-diff.js",
  );

  if (!pathExists(EDIT_DIFF_PATH)) {
    return; // pi-coding-agent not installed, skip
  }

  let content = readFile(EDIT_DIFF_PATH, "utf-8");

  // Check if already patched
  if (content.includes("usedFuzzyMatch")) {
    return; // Already patched
  }

  let patched = false;

  // Patch getNotFoundError function
  const oldNotFoundError = `function getNotFoundError(path, editIndex, totalEdits) {
    if (totalEdits === 1) {
        return new Error(\`Could not find the exact text in \${path}. The old text must match exactly including all whitespace and newlines.\`);
    }
    return new Error(\`Could not find edits[\${editIndex}] in \${path}. The oldText must match exactly including all whitespace and newlines.\`);
}`;

  const newNotFoundError = `function getNotFoundError(path, editIndex, totalEdits, usedFuzzyMatch) {
    const fuzzyHint = usedFuzzyMatch
        ? " (fuzzy matching was applied but the text was not found)"
        : "";
    if (totalEdits === 1) {
        return new Error(\`Could not find the text in \${path}. The old text must match exactly including all whitespace and newlines.\${fuzzyHint}\`);
    }
    return new Error(\`Could not find edits[\${editIndex}] in \${path}. The oldText must match exactly including all whitespace and newlines.\${fuzzyHint}\`);
}`;

  if (content.includes(oldNotFoundError)) {
    content = content.replace(oldNotFoundError, newNotFoundError);
    patched = true;
  }

  // Patch getDuplicateError function
  const oldDuplicateError = `function getDuplicateError(path, editIndex, totalEdits, occurrences) {
    if (totalEdits === 1) {
        return new Error(\`Found \${occurrences} occurrences of the text in \${path}. The text must be unique. Please provide more context to make it unique.\`);
    }
    return new Error(\`Found \${occurrences} occurrences of edits[\${editIndex}] in \${path}. Each oldText must be unique. Please provide more context to make it unique.\`);
}`;

  const newDuplicateError = `function getDuplicateError(path, editIndex, totalEdits, occurrences, usedFuzzyMatch) {
    const fuzzyHint = usedFuzzyMatch
        ? " (fuzzy matching normalized the text, causing multiple matches). Try including more surrounding context to make your oldText more specific."
        : "";
    if (totalEdits === 1) {
        return new Error(\`Found \${occurrences} occurrences of the text in \${path}. The text must be unique. Please provide more context to make it unique.\${fuzzyHint}\`);
    }
    return new Error(\`Found \${occurrences} occurrences of edits[\${editIndex}] in \${path}. Each oldText must be unique. Please provide more context to make it unique.\${fuzzyHint}\`);
}`;

  if (content.includes(oldDuplicateError)) {
    content = content.replace(oldDuplicateError, newDuplicateError);
    patched = true;
  }

  // Patch the call sites in applyEditsToNormalizedContent
  const oldMatchCheck = `        if (!matchResult.found) {
            throw getNotFoundError(path, i, normalizedEdits.length);
        }

        const occurrences = countOccurrences(baseContent, edit.oldText);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
        }`;

  const newMatchCheck = `        if (!matchResult.found) {
            throw getNotFoundError(path, i, normalizedEdits.length, matchResult.usedFuzzyMatch);
        }

        const occurrences = countOccurrences(baseContent, edit.oldText);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences, matchResult.usedFuzzyMatch);
        }`;

  if (content.includes(oldMatchCheck)) {
    content = content.replace(oldMatchCheck, newMatchCheck);
    patched = true;
  }

  if (patched) {
    writeFile(EDIT_DIFF_PATH, content, "utf-8");
    log.log(
      "[postinstall] patched pi-coding-agent edit-diff.js for improved fuzzy match error messages",
    );
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBundledPluginPostinstall();
  applyDependencyPatches();
}

export { applyDependencyPatches };
