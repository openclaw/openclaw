#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const extensionsRoot = path.join(repoRoot, "extensions");
const distExtensionsRoot = path.join(repoRoot, "dist", "extensions");

function rewritePackageExtensions(entries) {
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

for (const dirent of fs.readdirSync(extensionsRoot, { withFileTypes: true })) {
  if (!dirent.isDirectory()) {
    continue;
  }

  const pluginDir = path.join(extensionsRoot, dirent.name);
  const manifestPath = path.join(pluginDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    continue;
  }

  const distPluginDir = path.join(distExtensionsRoot, dirent.name);
  fs.mkdirSync(distPluginDir, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(distPluginDir, "openclaw.plugin.json"));

  const packageJsonPath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    continue;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (packageJson.openclaw && "extensions" in packageJson.openclaw) {
    packageJson.openclaw = {
      ...packageJson.openclaw,
      extensions: rewritePackageExtensions(packageJson.openclaw.extensions),
    };
  }

  fs.writeFileSync(
    path.join(distPluginDir, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    "utf8",
  );
}
