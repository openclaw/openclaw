#!/usr/bin/env node

import path from "node:path";
import {
  collectModuleExportNames,
  isExcludedExportCollisionSource,
  resolveExportModulePath,
  type ModuleExports,
  type SourceModule,
} from "./check-export-name-collisions.mts";
import { runWithFailedTrailer } from "./lib/failed-trailer.mts";
import { createNativeTypeScriptParser } from "./lib/native-typescript.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { collectSourceFileContents } from "./lib/source-file-scan-cache.mts";
import { runAsScript } from "./lib/ts-guard-utils.mts";

export type WrapperShadowingViolation = {
  name: string;
  wrapped: string;
  wrapper: string;
  via?: string;
};

function normalizeRelativePath(filePath: string) {
  return filePath.replaceAll(path.sep, "/");
}

export function isExcludedWrapperShadowingSource(filePath: string) {
  const normalized = normalizeRelativePath(filePath);
  const segments = normalized.split("/");
  return (
    isExcludedExportCollisionSource(normalized) ||
    segments.some((segment) =>
      ["__mocks__", "__tests__", "test-helpers", "test-support"].includes(segment),
    ) ||
    /-test-(?:helpers|support)\.[cm]?[jt]s$/u.test(normalized)
  );
}

function compareViolations(left: WrapperShadowingViolation, right: WrapperShadowingViolation) {
  return violationKey(left).localeCompare(violationKey(right));
}

function violationKey(violation: WrapperShadowingViolation) {
  return `${violation.name}\0${violation.wrapper}\0${violation.wrapped}\0${violation.via ?? ""}`;
}

// These released SQLite names are retained until the next Plugin SDK major.
// Only the SDK adapters warn; worker/Doctor primitives keep their canonical names.
// See SQLITE_RUNTIME_COMPAT_RECORDS in src/plugins/compat/sqlite-runtime-records.ts.
const sqliteSdkCompatibilityWrappers: readonly WrapperShadowingViolation[] = [
  {
    name: "borrowOpenClawAgentDatabase",
    wrapped: "src/state/openclaw-agent-db.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "executeSqliteQuerySync",
    wrapped: "src/infra/kysely-sync.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "executeSqliteQueryTakeFirstSync",
    wrapped: "src/infra/kysely-sync.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "getNodeSqliteKysely",
    wrapped: "src/infra/kysely-sync.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "iterateSqliteQuerySync",
    wrapped: "src/infra/kysely-sync.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "openNodeSqliteDatabase",
    wrapped: "src/infra/node-sqlite.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "openOpenClawAgentDatabase",
    wrapped: "src/state/openclaw-agent-db.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "prepareSqliteQuerySync",
    wrapped: "src/infra/kysely-sync.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "runOpenClawAgentWriteAdmission",
    wrapped: "src/state/openclaw-agent-write-admission.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "runSqliteImmediateTransaction",
    wrapped: "src/infra/sqlite-transaction.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "runSqliteImmediateTransactionSync",
    wrapped: "src/infra/sqlite-transaction.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "withOpenClawAgentDatabaseAsync",
    wrapped: "src/state/openclaw-agent-db.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "withOpenClawAgentDatabaseRuntime",
    wrapped: "src/state/openclaw-agent-db.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
  {
    name: "withOpenClawAgentDatabaseWrite",
    wrapped: "src/state/openclaw-agent-db-write.ts",
    wrapper: "src/plugin-sdk/sqlite-runtime-legacy.ts",
  },
];

function resolveSourceModulePath(
  sourcePath: string,
  specifier: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
) {
  const pluginSdkPrefix = specifier.startsWith("openclaw/plugin-sdk/")
    ? "openclaw/plugin-sdk/"
    : specifier.startsWith("@openclaw/plugin-sdk/")
      ? "@openclaw/plugin-sdk/"
      : null;
  if (!pluginSdkPrefix) {
    return resolveExportModulePath(sourcePath, specifier, modulesByPath);
  }
  return resolveExportModulePath(
    "src/plugin-sdk/importer.ts",
    `./${specifier.slice(pluginSdkPrefix.length)}`,
    modulesByPath,
  );
}

function resolveWrappedDefinition(
  wrapperPath: string,
  exportName: string,
  moduleSpecifier: string,
  modulesByPath: ReadonlyMap<string, ModuleExports>,
) {
  const importedPath = resolveSourceModulePath(wrapperPath, moduleSpecifier, modulesByPath);
  if (!importedPath) {
    return null;
  }

  const reachablePaths = new Set([importedPath]);
  const wrappedPaths = new Set<string>();
  // Set iteration visits newly discovered modules once, including cyclic barrels.
  for (const modulePath of reachablePaths) {
    const moduleExports = modulesByPath.get(modulePath);
    if (!moduleExports) {
      continue;
    }
    if (moduleExports.valueDefinitions.has(exportName)) {
      wrappedPaths.add(modulePath);
      if (wrappedPaths.size > 1) {
        return null;
      }
      continue;
    }

    const namedExports = moduleExports.namedReExports.filter(
      (reExport) => reExport.exportedName === exportName,
    );
    // An explicit binding shadows stars, even when its renamed target is outside
    // this same-name guard. Falling through would attribute a different function.
    const specifiers =
      namedExports.length > 0
        ? namedExports
            .filter((reExport) => reExport.importedName === exportName)
            .map((reExport) => reExport.moduleSpecifier)
        : moduleExports.starExportSpecifiers;
    for (const specifier of specifiers) {
      const target = resolveSourceModulePath(modulePath, specifier, modulesByPath);
      if (target) {
        reachablePaths.add(target);
      }
    }
  }

  const [wrapped] = wrappedPaths;
  return wrapped ? { wrapped, ...(wrapped !== importedPath ? { via: importedPath } : {}) } : null;
}

/** Finds exported wrappers that shadow the same imported source symbol. */
export function findWrapperShadowingViolations(modules: SourceModule[]) {
  using parser = createNativeTypeScriptParser();
  const modulesByPath = new Map<string, ModuleExports>();
  const sortedModules = modules.toSorted((left, right) => left.path.localeCompare(right.path));
  // Reload native roots once per bounded batch, retaining only the export graph.
  const batchSize = 32;
  for (let offset = 0; offset < sortedModules.length; offset += batchSize) {
    const batch = sortedModules.slice(offset, offset + batchSize);
    const sourceFiles = parser.parseSourceFiles(
      batch.map((sourceModule) => ({
        fileName: normalizeRelativePath(sourceModule.path),
        text: sourceModule.content,
      })),
    );
    for (const [index, sourceFile] of sourceFiles.entries()) {
      const sourceModule = batch[index]!;
      const modulePath = normalizeRelativePath(sourceModule.path);
      modulesByPath.set(modulePath, collectModuleExportNames(modulePath, sourceFile));
    }
  }

  const violations = new Map<string, WrapperShadowingViolation>();
  for (const [wrapperPath, moduleExports] of modulesByPath) {
    for (const [name, definition] of moduleExports.valueDefinitions) {
      for (const reference of definition.importedReferences) {
        if (reference.importedName !== name) {
          continue;
        }
        const wrappedDefinition = resolveWrappedDefinition(
          wrapperPath,
          name,
          reference.moduleSpecifier,
          modulesByPath,
        );
        if (!wrappedDefinition || wrappedDefinition.wrapped === wrapperPath) {
          continue;
        }
        const violation: WrapperShadowingViolation = {
          name,
          wrapped: wrappedDefinition.wrapped,
          wrapper: wrapperPath,
          ...(wrappedDefinition.via ? { via: wrappedDefinition.via } : {}),
        };
        violations.set(violationKey(violation), violation);
      }
    }
  }
  return [...violations.values()].toSorted(compareViolations);
}

export async function collectRepositoryWrapperShadowing(repoRoot: string) {
  const files = await collectSourceFileContents({
    repoRoot,
    scanRoots: ["src"],
    scanExtensions: new Set([".ts", ".mts", ".js", ".mjs"]),
    ignoredDirNames: new Set(["node_modules", "test", "__fixtures__"]),
  });
  const modules = files
    .filter(({ relativeFile }) => !isExcludedWrapperShadowingSource(relativeFile))
    .map(({ content, relativeFile }) => ({ content, path: relativeFile }));
  return findWrapperShadowingViolations(modules);
}

export async function main(
  repoRoot = resolveRepoRoot(import.meta.url),
  argv = process.argv.slice(2),
) {
  if (argv.length > 0) {
    console.error(`Unknown argument(s): ${argv.join(", ")}`);
    return 2;
  }

  const observed = await collectRepositoryWrapperShadowing(repoRoot);
  const observedKeys = new Set(observed.map(violationKey));
  const compatibilityKeys = new Set(sqliteSdkCompatibilityWrappers.map(violationKey));
  const stale = sqliteSdkCompatibilityWrappers.filter(
    (violation) => !observedKeys.has(violationKey(violation)),
  );
  if (stale.length > 0) {
    console.error("Remove stale released-SDK wrapper exceptions:");
    for (const violation of stale) {
      console.error(`- ${JSON.stringify(violation)}`);
    }
    return 1;
  }
  const violations = observed.filter(
    (violation) => !compatibilityKeys.has(violationKey(violation)),
  );
  if (violations.length === 0) {
    console.log("wrapper shadowing guard passed.");
    return 0;
  }

  console.error("Found same-name wrapper shadowing:");
  for (const violation of violations) {
    console.error(`- ${JSON.stringify(violation)}`);
  }
  console.error(
    "Keep the canonical name on the behavior-complete outer function; rename wrapped implementations with a distinguishing suffix, or use a pure re-export when no behavior is added.",
  );
  return 1;
}

runAsScript(import.meta.url, () =>
  runWithFailedTrailer("check-wrapper-shadowing", async () => {
    process.exitCode = await main();
  }),
);
