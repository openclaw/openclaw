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

function dynamicImportMemberNames(source, specifier) {
  return [
    ...new Set(
      [
        ...source.matchAll(
          /\(\s*await\s+import\(\s*["']([^"'\r\n]+)["']\s*\)\s*\)\s*\.\s*([A-Za-z_$][\w$]*)/gu,
        ),
      ].flatMap(([, importedFrom, name]) => (importedFrom === specifier ? [name] : [])),
    ),
  ];
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
 * @returns {string}
 */
export function compileDynamicConsumerEdges(source, filePath) {
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

  return `${source}\n${imports.join("\n")}`;
}
