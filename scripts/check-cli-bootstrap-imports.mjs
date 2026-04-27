#!/usr/bin/env node

import fs from "node:fs";
import module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENTRYPOINTS = ["dist/entry.js", "dist/cli/run-main.js"];
const STATIC_IMPORT_RE =
  /\b(?:import|export)\s+(?:(?:[^'"()]*?\s+from\s+)|)["'](?<specifier>[^"']+)["']/gu;

function isMainModule() {
  return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
}

function isBuiltinSpecifier(specifier) {
  return specifier.startsWith("node:") || module.isBuiltin(specifier);
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

function resolveRelativeImport(importer, specifier, fsImpl = fs) {
  const base = specifier.startsWith("/")
    ? specifier
    : path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    path.join(base, "index.js"),
    path.join(base, "index.mjs"),
    path.join(base, "index.cjs"),
  ];
  return candidates.find((candidate) => {
    try {
      return fsImpl.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

export function listStaticImportSpecifiers(source) {
  return [...source.matchAll(STATIC_IMPORT_RE)].map((match) => match.groups?.specifier ?? "");
}

export function collectCliBootstrapExternalImportErrors(params = {}) {
  const rootDir = params.rootDir ?? process.cwd();
  const entrypoints = params.entrypoints ?? DEFAULT_ENTRYPOINTS;
  const fsImpl = params.fs ?? fs;
  const queue = entrypoints.map((entrypoint) => path.resolve(rootDir, entrypoint));
  const visited = new Set();
  const errors = [];

  for (let index = 0; index < queue.length; index += 1) {
    const filePath = queue[index];
    if (!filePath || visited.has(filePath)) {
      continue;
    }
    visited.add(filePath);

    let source;
    try {
      source = fsImpl.readFileSync(filePath, "utf8");
    } catch {
      errors.push(
        `CLI bootstrap import guard could not read ${path.relative(rootDir, filePath) || filePath}. Run pnpm build first.`,
      );
      continue;
    }

    for (const specifier of listStaticImportSpecifiers(source)) {
      if (!specifier || isBuiltinSpecifier(specifier)) {
        continue;
      }
      if (!isRelativeSpecifier(specifier)) {
        errors.push(
          `CLI bootstrap static graph imports external package "${specifier}" from ${path.relative(
            rootDir,
            filePath,
          )}.`,
        );
        continue;
      }
      const resolved = resolveRelativeImport(filePath, specifier, fsImpl);
      if (!resolved) {
        errors.push(
          `CLI bootstrap import guard could not resolve "${specifier}" from ${path.relative(
            rootDir,
            filePath,
          )}.`,
        );
        continue;
      }
      if (!visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return errors.toSorted((left, right) => left.localeCompare(right));
}

export function checkCliBootstrapExternalImports(params = {}) {
  const errors = collectCliBootstrapExternalImportErrors(params);
  if (errors.length === 0) {
    return;
  }
  const logger = params.logger ?? console;
  logger.error("CLI bootstrap import guard failed:");
  for (const error of errors) {
    logger.error(`  - ${error}`);
  }
  throw new Error("CLI bootstrap static graph imports external packages.");
}

if (isMainModule()) {
  try {
    checkCliBootstrapExternalImports();
    console.log("CLI bootstrap import guard passed.");
  } catch {
    process.exit(1);
  }
}
