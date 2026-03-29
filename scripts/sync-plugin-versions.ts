import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageJson = {
  name?: string;
  version?: string;
  devDependencies?: Record<string, string>;
};

function ensureChangelogEntry(changelogPath: string, version: string): boolean {
  if (!existsSync(changelogPath)) {
    return false;
  }
  const content = readFileSync(changelogPath, "utf8");
  if (content.includes(`## ${version}`)) {
    return false;
  }
  const entry = `## ${version}\n\n### Changes\n- Version alignment with core OpenClaw release numbers.\n\n`;
  if (content.startsWith("# Changelog\n\n")) {
    const next = content.replace("# Changelog\n\n", `# Changelog\n\n${entry}`);
    writeFileSync(changelogPath, next);
    return true;
  }
  const next = `# Changelog\n\n${entry}${content.trimStart()}`;
  writeFileSync(changelogPath, `${next}\n`);
  return true;
}

function stripWorkspaceOpenclawDevDependency(pkg: PackageJson): boolean {
  const devDeps = pkg.devDependencies;
  if (!devDeps || devDeps.openclaw !== "workspace:*") {
    return false;
  }
  delete devDeps.openclaw;
  if (Object.keys(devDeps).length === 0) {
    delete pkg.devDependencies;
  }
  return true;
}

export function syncPluginVersions(rootDir = resolve(".")) {
  const rootPackagePath = join(rootDir, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;
  if (!targetVersion) {
    throw new Error("Root package.json missing version.");
  }

  const extensionsDir = join(rootDir, "extensions");
  const dirs = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const updated: string[] = [];
  const changelogged: string[] = [];
  const skipped: string[] = [];
  const strippedWorkspaceDevDeps: string[] = [];

  for (const dir of dirs) {
    const packagePath = join(extensionsDir, dir.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name) {
      skipped.push(dir.name);
      continue;
    }

    const changelogPath = join(extensionsDir, dir.name, "CHANGELOG.md");
    if (ensureChangelogEntry(changelogPath, targetVersion)) {
      changelogged.push(pkg.name);
    }

    const removedWorkspaceDevDependency = stripWorkspaceOpenclawDevDependency(pkg);
    if (removedWorkspaceDevDependency) {
      strippedWorkspaceDevDeps.push(pkg.name);
    }

    const versionChanged = pkg.version !== targetVersion;
    if (!versionChanged && !removedWorkspaceDevDependency) {
      skipped.push(pkg.name);
      continue;
    }

    pkg.version = targetVersion;
    writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    updated.push(pkg.name);
  }

  return {
    targetVersion,
    updated,
    changelogged,
    skipped,
    strippedWorkspaceDevDeps,
  };
}

if (import.meta.main) {
  const summary = syncPluginVersions();
  console.log(
    `Synced plugin versions to ${summary.targetVersion}. Updated: ${summary.updated.length}. Changelogged: ${summary.changelogged.length}. Stripped workspace devDeps: ${summary.strippedWorkspaceDevDeps.length}. Skipped: ${summary.skipped.length}.`,
  );
}
