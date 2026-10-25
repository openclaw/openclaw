import fs from "node:fs";
import path from "node:path";

function relativeSpecifier(fromFile, targetFile) {
  const relative = path
    .relative(path.dirname(path.resolve(fromFile)), path.resolve(targetFile))
    .replaceAll("\\", "/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function importedNames(source, specifier) {
  return [...source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu)].flatMap(
    ([, bindings, importedFrom]) =>
      importedFrom === specifier
        ? bindings
            .split(",")
            .map(
              (binding) =>
                binding
                  .trim()
                  .replace(/^type\s+/u, "")
                  .split(/\s+as\s+/u)[0],
            )
            .filter(Boolean)
        : [],
  );
}

function generatesRuntimeScriptAsset(entry) {
  // Keep this projection aligned with the generator's manifest-driven ASSETS loop.
  return entry.kind === "data-url" || ("materialize" in entry && entry.materialize);
}

export function collectRuntimeProcessManifestEntries(scriptEntrypoints, toolingEntrypoints) {
  const entries = new Set(Object.values(toolingEntrypoints));
  for (const entry of Object.values(scriptEntrypoints)) {
    if ("buildSource" in entry) {
      entries.add(entry.buildSource);
    }
    if (generatesRuntimeScriptAsset(entry)) {
      entries.add(entry.sourceModule);
    }
  }
  return [...entries];
}

function dynamicImportMemberNames(source, specifier) {
  return [
    ...new Set(
      [
        // Also matches a memoized load: `(await (module ??= import("..."))).name`.
        ...source.matchAll(
          /\(\s*await\s+(?:import\(\s*["']([^"'\r\n]+)["']\s*\)|\(\s*[A-Za-z_$][\w$]*\s*\?\?=\s*import\(\s*["']([^"'\r\n]+)["']\s*\)\s*\))\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gu,
        ),
      ].flatMap(([, direct, memoized, name]) => ((direct ?? memoized) === specifier ? [name] : [])),
    ),
  ];
}

function lazyModuleNamespaces(source) {
  const assignment = source.match(
    /\bconst\s*\[([\s\S]*?)\]\s*=\s*await\s+Promise\.all\(\s*\[([\s\S]*?)\]\s*\)\s*;/u,
  );
  if (!assignment) {
    return new Map();
  }
  const bindings = assignment[1]
    .split(",")
    .map((binding) => binding.trim())
    .filter(Boolean);
  const specifiers = [...assignment[2].matchAll(/\bimport\(\s*["']([^"'\r\n]+)["']\s*\)/gu)].map(
    (match) => match[1],
  );
  if (bindings.length !== specifiers.length) {
    return new Map();
  }

  const bindingSpecifiers = new Map(bindings.map((binding, index) => [binding, specifiers[index]]));
  const returned = source.match(/\breturn\s*\{([^{}]+)\}\s*;/u)?.[1] ?? "";
  return new Map(
    returned
      .split(",")
      .map((property) =>
        property.trim().match(/^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/u),
      )
      .filter(Boolean)
      .flatMap((match) => {
        const specifier = bindingSpecifiers.get(match[2] ?? match[1]);
        return specifier ? [[match[1], specifier]] : [];
      }),
  );
}

function loadedNamespaceMemberNames(source, loaderName) {
  const members = new Map();
  const escapedLoaderName = loaderName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const destructuring = new RegExp(
    `\\bconst\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}\\s*=\\s*await\\s+${escapedLoaderName}\\(\\s*\\)\\s*;`,
    "gu",
  );
  for (const match of source.matchAll(destructuring)) {
    for (const namespace of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*\{([^{}]+)\}/gu)) {
      const names = members.get(namespace[1]) ?? new Set();
      for (const binding of namespace[2].split(",")) {
        const name = binding.trim().split(/\s*:\s*/u)[0];
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) {
          names.add(name);
        }
      }
      members.set(namespace[1], names);
    }
  }
  return members;
}

function emittedNamedImportEdges(source) {
  const transforms = new Map(
    [
      ...source.matchAll(/^def\s+([A-Za-z_]\w*)\(s\):\n([\s\S]*?)(?=^def\s+|^edit\(|^for\s+)/gmu),
    ].map((match) => [match[1], match[2]]),
  );
  const edges = new Map();
  for (const match of source.matchAll(
    /^edit\(\s*["']([^"'\r\n]+)["']\s*,\s*([A-Za-z_]\w*)\s*\)/gmu,
  )) {
    const body = transforms.get(match[2]);
    if (!body) {
      continue;
    }
    for (const imported of body.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu,
    )) {
      const targetFile = path.resolve(path.dirname(match[1]), imported[2]);
      const names = edges.get(targetFile) ?? new Set();
      for (const binding of imported[1].split(",")) {
        const name = binding.trim().split(/\s+as\s+/u)[0];
        if (name) {
          names.add(name);
        }
      }
      edges.set(targetFile, names);
    }
  }
  return edges;
}

function emittedFileNamedImportEdges(source) {
  const outputPaths = new Map(
    [
      ...source.matchAll(
        /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*[A-Za-z_$][\w$]*\s*,\s*["']([^"'\r\n]+)["']\s*\)\s*;/gu,
      ),
    ].map(([, binding, outputPath]) => [binding, outputPath]),
  );
  const edges = new Map();
  for (const match of source.matchAll(
    /\b(?:fs\.)?writeFileSync\(\s*([A-Za-z_$][\w$]*)\s*,([\s\S]*?)\n\s*\);/gu,
  )) {
    const outputPath = outputPaths.get(match[1]);
    if (!outputPath) {
      continue;
    }
    for (const imported of match[2].matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*["']([^"'\r\n]+)["']/gu,
    )) {
      const targetFile = path.resolve(path.dirname(outputPath), imported[2]);
      const names = edges.get(targetFile) ?? new Set();
      for (const binding of imported[1].split(",")) {
        const name = binding
          .trim()
          .replace(/^type\s+/u, "")
          .split(/\s+as\s+/u)[0];
        if (name) {
          names.add(name);
        }
      }
      edges.set(targetFile, names);
    }
  }
  return edges;
}

function namedImport(names, targetFile, consumerFile, index) {
  const bindings = names.map(
    (name, bindingIndex) => `${name} as __dynamic${index}_${bindingIndex}`,
  );
  return `import { ${bindings.join(", ")} } from ${JSON.stringify(relativeSpecifier(consumerFile, targetFile))};`;
}

/**
 * Project named imports emitted into child modules or selected through module
 * hooks. Each edge is derived from the live producer and consumer sources so
 * removing either side restores the unused-export finding.
 *
 * @param {string} source
 * @param {string} filePath
 * @param {Record<string, {kind: string, sourceModule: string, sourceBinding?: string, materialize?: boolean}>} [scriptEntrypoints]
 * @returns {string}
 */
export function compileDynamicConsumerEdges(source, filePath, scriptEntrypoints = {}) {
  const imports = [];

  const tsdownPath = "tsdown.config.ts";
  const runtimeManifestSpecifier = "./src/infra/runtime-process-manifest.ts";
  const manifestNames = importedNames(
    fs.readFileSync(tsdownPath, "utf8"),
    runtimeManifestSpecifier,
  );
  if (manifestNames.length > 0) {
    imports.push(
      namedImport(
        manifestNames,
        path.resolve(path.dirname(tsdownPath), runtimeManifestSpecifier),
        filePath,
        imports.length,
      ),
    );
  }

  const benchmarkGeneratorPath = "scripts/lib/gateway-bench-worker-messages.ts";
  const benchmarkGenerator = fs.readFileSync(benchmarkGeneratorPath, "utf8");
  const generatedNames = [
    ...benchmarkGenerator.matchAll(
      /\bimport\s*\{([^}]+)\}\s*from\s*\$\{JSON\.stringify\(import\.meta\.url\)\};/gu,
    ),
  ].flatMap(([, bindings]) =>
    bindings
      .split(",")
      .map((binding) => binding.trim().split(/\s+as\s+/u)[0])
      .filter(Boolean),
  );
  if (generatedNames.length > 0) {
    imports.push(namedImport(generatedNames, benchmarkGeneratorPath, filePath, imports.length));
  }

  const transportPath = "extensions/team-reports/src/report-fixture-transport.test-support.ts";
  const redirectedSpecifier = fs
    .readFileSync(transportPath, "utf8")
    .match(/\bspecifier\s*===\s*["']([^"'\r\n]+)["']/u)?.[1];
  const benchmarkPath = "extensions/team-reports/src/report-run.benchmark.test-support.ts";
  const fixtureSpecifier = fs
    .readFileSync(benchmarkPath, "utf8")
    .match(/\binstallReportFixtureTransport\(\s*["']([^"'\r\n]+)["']/u)?.[1];
  if (redirectedSpecifier && fixtureSpecifier) {
    const runtimeConsumer = fs.readFileSync("extensions/team-reports/src/sources/http.ts", "utf8");
    const names = importedNames(runtimeConsumer, redirectedSpecifier);
    if (names.length > 0) {
      imports.push(
        namedImport(
          names,
          path.resolve(path.dirname(benchmarkPath), fixtureSpecifier),
          filePath,
          imports.length,
        ),
      );
    }
  }

  const doctorConsumerPath = "src/commands/config-preflight-snapshot.ts";
  const doctorLegacySpecifier = "./doctor/shared/legacy-config-issues.js";
  const doctorLegacyNames = dynamicImportMemberNames(
    fs.readFileSync(doctorConsumerPath, "utf8"),
    doctorLegacySpecifier,
  );
  if (doctorLegacyNames.length > 0) {
    imports.push(
      namedImport(
        doctorLegacyNames,
        path.resolve(path.dirname(doctorConsumerPath), doctorLegacySpecifier),
        filePath,
        imports.length,
      ),
    );
  }

  const mcpLoaderPath = "src/agents/agent-bundle-mcp-runtime-modules.ts";
  const mcpRuntimePath = "src/agents/agent-bundle-mcp-runtime.ts";
  const mcpNamespaces = lazyModuleNamespaces(fs.readFileSync(mcpLoaderPath, "utf8"));
  const mcpMembers = loadedNamespaceMemberNames(
    fs.readFileSync(mcpRuntimePath, "utf8"),
    "loadBundleMcpRuntimeModules",
  );
  for (const [namespace, specifier] of mcpNamespaces) {
    if (!specifier.startsWith(".")) {
      continue;
    }
    const names = [...(mcpMembers.get(namespace) ?? [])];
    if (names.length > 0) {
      imports.push(
        namedImport(
          names,
          path.resolve(path.dirname(mcpLoaderPath), specifier),
          filePath,
          imports.length,
        ),
      );
    }
  }

  const rowChurnInstrumenter = fs.readFileSync(
    "scripts/perf/session-row-churn-instrument.py",
    "utf8",
  );
  for (const [targetFile, names] of emittedNamedImportEdges(rowChurnInstrumenter)) {
    imports.push(namedImport([...names], targetFile, filePath, imports.length));
  }

  const runtimeAssetGeneratorPath = "scripts/generate-runtime-script-assets.mjs";
  const materializerSpecifier = "./src/infra/runtime-process-script-file.ts";
  const materializerNames = importedNames(
    fs.readFileSync(runtimeAssetGeneratorPath, "utf8"),
    materializerSpecifier,
  );
  if (materializerNames.length > 0) {
    imports.push(
      namedImport(materializerNames, path.resolve(materializerSpecifier), filePath, imports.length),
    );
  }

  const prepareHooksPath = "scripts/prepare-git-hooks.mjs";
  const bootstrapSpecifier = "../runtime-process-bootstrap.generated.mjs";
  const bootstrapNames = importedNames(
    fs.readFileSync(prepareHooksPath, "utf8"),
    bootstrapSpecifier,
  );
  if (bootstrapNames.length > 0) {
    imports.push(
      namedImport(
        bootstrapNames,
        path.resolve(path.dirname(prepareHooksPath), bootstrapSpecifier),
        filePath,
        imports.length,
      ),
    );
  }

  const workerArtifactsPath = "test/scripts/vitest-worker-artifacts.test.ts";
  const emittedWorkerEdges = emittedFileNamedImportEdges(
    fs.readFileSync(workerArtifactsPath, "utf8"),
  );
  const sqliteFacadePath = path.resolve("node-sqlite.mjs");
  const sqliteFacadeNames = [...(emittedWorkerEdges.get(sqliteFacadePath) ?? [])];
  if (sqliteFacadeNames.length > 0) {
    imports.push(namedImport(sqliteFacadeNames, sqliteFacadePath, filePath, imports.length));
  }

  for (const entry of Object.values(scriptEntrypoints)) {
    if (generatesRuntimeScriptAsset(entry) && entry.sourceBinding) {
      imports.push(
        namedImport(
          [entry.sourceBinding],
          path.resolve(entry.sourceModule),
          filePath,
          imports.length,
        ),
      );
    }
  }

  return `${source}\n${imports.join("\n")}`;
}
