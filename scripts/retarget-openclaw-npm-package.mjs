#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_PACKAGE_NAME = "openclaw";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const SCOPED_PACKAGE_PATTERN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/u;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function fail(message) {
  throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function validateForkNpmPackageTarget(packageName, repository) {
  if (
    packageName.length > 214 ||
    packageName !== packageName.toLowerCase() ||
    !SCOPED_PACKAGE_PATTERN.test(packageName)
  ) {
    fail(
      `fork npm package name must be a lowercase scoped package; got ${packageName || "<empty>"}`,
    );
  }
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) {
    fail(`GitHub repository must use owner/name syntax; got ${repository || "<empty>"}`);
  }
}

export function retargetOpenClawNpmPackage({ packageName, repository, rootDir }) {
  validateForkNpmPackageTarget(packageName, repository);

  const packageJsonPath = path.join(rootDir, "package.json");
  const shrinkwrapPath = path.join(rootDir, "npm-shrinkwrap.json");
  const packageJson = readJson(packageJsonPath);
  const shrinkwrap = readJson(shrinkwrapPath);
  const shrinkwrapRoot = shrinkwrap.packages?.[""];

  if (packageJson.name !== SOURCE_PACKAGE_NAME) {
    fail(
      `package.json must start as ${SOURCE_PACKAGE_NAME}; found ${packageJson.name ?? "<missing>"}`,
    );
  }
  if (shrinkwrap.name !== SOURCE_PACKAGE_NAME || shrinkwrapRoot?.name !== SOURCE_PACKAGE_NAME) {
    fail("npm-shrinkwrap.json must start with the OpenClaw root package identity");
  }
  if (
    packageJson.version !== shrinkwrap.version ||
    packageJson.version !== shrinkwrapRoot.version
  ) {
    fail("package.json and npm-shrinkwrap.json versions must match before retargeting");
  }

  const repositoryUrl = `git+https://github.com/${repository}.git`;
  packageJson.name = packageName;
  packageJson.homepage = `https://github.com/${repository}#readme`;
  packageJson.bugs = { ...packageJson.bugs, url: `https://github.com/${repository}/issues` };
  packageJson.repository = { type: "git", url: repositoryUrl };
  packageJson.publishConfig = {
    ...packageJson.publishConfig,
    access: "public",
    registry: NPM_REGISTRY,
  };
  shrinkwrap.name = packageName;
  shrinkwrapRoot.name = packageName;

  writeJson(packageJsonPath, packageJson);
  writeJson(shrinkwrapPath, shrinkwrap);

  return {
    packageName,
    repository,
    repositoryUrl,
    version: packageJson.version,
  };
}

function parseArgs(argv) {
  const values = { packageName: "", repository: "", rootDir: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--package-name" && value) {
      values.packageName = value;
      index += 1;
    } else if (arg === "--repository" && value) {
      values.repository = value;
      index += 1;
    } else if (arg === "--root" && value) {
      values.rootDir = path.resolve(value);
      index += 1;
    } else {
      fail(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (!values.packageName || !values.repository) {
    fail(
      "usage: retarget-openclaw-npm-package.mjs --package-name <@scope/name> --repository <owner/repo> [--root <dir>]",
    );
  }
  return values;
}

const entrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;
if (entrypoint) {
  try {
    const result = retargetOpenClawNpmPackage(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    console.error(
      `retarget-openclaw-npm-package: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
