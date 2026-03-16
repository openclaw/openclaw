import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  removeFileIfExists,
  removePathIfExists,
  writeTextFileIfChanged,
} from "./runtime-postbuild-shared.mjs";

const GENERATED_BUNDLED_SKILLS_DIR = "bundled-skills";

export function rewritePackageExtensions(entries) {
  if (!Array.isArray(entries)) {
    return undefined;
  }

  return entries
    .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => {
      const normalized = entry.replace(/^\.\//, "");
      const rewritten = normalized.replace(/\.[^.]+$/u, ".js");
      return `./${rewritten}`;
    });
}

function rewritePackageEntry(entry) {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    return undefined;
  }
  const normalized = entry.replace(/^\.\//, "");
  const rewritten = normalized.replace(/\.[^.]+$/u, ".js");
  return `./${rewritten}`;
}

function ensurePathInsideRoot(rootDir, rawPath) {
  const resolved = path.resolve(rootDir, rawPath);
  const relative = path.relative(rootDir, resolved);
  if (
    relative === "" ||
    relative === "." ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return resolved;
  }
  throw new Error(`path escapes plugin root: ${rawPath}`);
}

function normalizeManifestRelativePath(rawPath) {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function resolveDeclaredSkillSourcePath(params) {
  const normalized = normalizeManifestRelativePath(params.rawPath);
  const pluginLocalPath = ensurePathInsideRoot(params.pluginDir, normalized);
  if (fs.existsSync(pluginLocalPath)) {
    return pluginLocalPath;
  }
  if (!/^node_modules(?:\/|$)/u.test(normalized)) {
    return pluginLocalPath;
  }
  return ensurePathInsideRoot(params.repoRoot, normalized);
}

function resolveBundledSkillTarget(rawPath) {
  const normalized = normalizeManifestRelativePath(rawPath);
  if (/^node_modules(?:\/|$)/u.test(normalized)) {
    // Bundled dist/plugin roots must not publish nested node_modules trees. Relocate
    // dependency-backed skill assets into a dist-owned directory and rewrite the manifest.
    const trimmed = normalized.replace(/^node_modules\/?/u, "");
    if (!trimmed) {
      throw new Error(`node_modules skill path must point to a package: ${rawPath}`);
    }
    const bundledRelativePath = `${GENERATED_BUNDLED_SKILLS_DIR}/${trimmed}`;
    return {
      manifestPath: `./${bundledRelativePath}`,
      outputPath: bundledRelativePath,
    };
  }
  return {
    manifestPath: rawPath,
    outputPath: normalized,
  };
}

function copyDeclaredPluginSkillPaths(params) {
  const skills = Array.isArray(params.manifest.skills) ? params.manifest.skills : [];
  const copiedSkills = [];
  for (const raw of skills) {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    const sourcePath = resolveDeclaredSkillSourcePath({
      rawPath: raw,
      pluginDir: params.pluginDir,
      repoRoot: params.repoRoot,
    });
    const target = resolveBundledSkillTarget(raw);
    if (!fs.existsSync(sourcePath)) {
      // Some Docker/lightweight builds intentionally omit optional plugin-local
      // dependencies. Only advertise skill paths that were actually bundled.
      console.warn(
        `[bundled-plugin-metadata] skipping missing skill path ${sourcePath} (plugin ${params.manifest.id ?? path.basename(params.pluginDir)})`,
      );
      continue;
    }
    const targetPath = ensurePathInsideRoot(params.distPluginDir, target.outputPath);
    removePathIfExists(targetPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const shouldExcludeNestedNodeModules = /^node_modules(?:\/|$)/u.test(
      normalizeManifestRelativePath(raw),
    );
    fs.cpSync(sourcePath, targetPath, {
      dereference: true,
      force: true,
      recursive: true,
      filter: (candidatePath) => {
        if (!shouldExcludeNestedNodeModules || candidatePath === sourcePath) {
          return true;
        }
        const relativeCandidate = path.relative(sourcePath, candidatePath).replaceAll("\\", "/");
        return !relativeCandidate.split("/").includes("node_modules");
      },
    });
    copiedSkills.push(target.manifestPath);
  }
  return copiedSkills;
}

export function copyBundledPluginMetadata(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const extensionsRoot = path.join(repoRoot, "extensions");
  const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");
  if (!fs.existsSync(extensionsRoot)) {
    return;
  }

  const sourcePluginDirs = new Set();
  for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    sourcePluginDirs.add(dirent.name);

    const pluginDir = path.join(extensionsRoot, dirent.name);
    const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const distManifestPath = path.join(distPluginDir, "openclaw.plugin.json");
    const distPackageJsonPath = path.join(distPluginDir, "package.json");
    if (!fs.existsSync(manifestPath)) {
      removePathIfExists(distPluginDir);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    // Generated skill assets live under a dedicated dist-owned directory. Also
    // remove the older bad node_modules tree so release packs cannot pick it up.
    removePathIfExists(path.join(distPluginDir, GENERATED_BUNDLED_SKILLS_DIR));
    removePathIfExists(path.join(distPluginDir, "node_modules"));
    const copiedSkills = copyDeclaredPluginSkillPaths({
      manifest,
      pluginDir,
      distPluginDir,
      repoRoot,
    });
    const bundledManifest = Array.isArray(manifest.skills)
      ? { ...manifest, skills: copiedSkills }
      : manifest;
    writeTextFileIfChanged(distManifestPath, `${JSON.stringify(bundledManifest, null, 2)}\n`);

    const packageJsonPath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      removeFileIfExists(distPackageJsonPath);
      continue;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (packageJson.openclaw && "extensions" in packageJson.openclaw) {
      packageJson.openclaw = {
        ...packageJson.openclaw,
        extensions: rewritePackageExtensions(packageJson.openclaw.extensions),
        ...(typeof packageJson.openclaw.setupEntry === "string"
          ? { setupEntry: rewritePackageEntry(packageJson.openclaw.setupEntry) }
          : {}),
      };
    }

    writeTextFileIfChanged(distPackageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }

  if (!fs.existsSync(distExtensionsRoot)) {
    return;
  }

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || sourcePluginDirs.has(dirent.name)) {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    removePathIfExists(distPluginDir);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyBundledPluginMetadata();
}
