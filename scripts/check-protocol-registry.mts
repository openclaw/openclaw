import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const repoRoot = resolveRepoRoot(import.meta.url);
const failures: string[] = [];
const read = (relativePath: string) => fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
const check = (condition: unknown, message: string) => {
  if (!condition) {
    failures.push(message);
  }
};
const parse = (relativePath: string) =>
  ts.createSourceFile(relativePath, read(relativePath), ts.ScriptTarget.Latest, true);
const selectionPath = "packages/gateway-protocol/src/schema/protocol-schema-selection.ts";
const selection = parse(selectionPath);
const exclusionDeclaration = selection.statements
  .flatMap((statement) =>
    ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
  )
  .find(
    (declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text === "EXCLUDED_SCHEMA_EXPORTS",
  );
let initializer = exclusionDeclaration?.initializer;
while (initializer && (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer))) {
  initializer = initializer.expression;
}
const exclusionElements =
  initializer && ts.isArrayLiteralExpression(initializer) ? initializer.elements : undefined;
check(exclusionElements?.every(ts.isStringLiteral), "schema exclusions must remain literal names");
const excludedNames =
  exclusionElements?.filter(ts.isStringLiteral).map((value) => value.text) ?? [];
const excluded = new Set(excludedNames);
check(excluded.size === excludedNames.length, "schema exclusions must not contain duplicates");
const skillNames: string[] = [];
for (const statement of selection.statements) {
  if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
    continue;
  }
  const specifier = statement.moduleSpecifier.text;
  check(
    ["typebox", "../schema-modules.js", "./skill-library.js"].includes(specifier),
    `${selectionPath} must resolve schemas through the existing canonical source owners`,
  );
  if (specifier === "./skill-library.js") {
    const bindings = statement.importClause?.namedBindings;
    check(
      bindings && ts.isNamedImports(bindings),
      "skill-library schema selection must be explicit",
    );
    if (bindings && ts.isNamedImports(bindings)) {
      skillNames.push(
        ...bindings.elements.map((binding) => binding.propertyName?.text ?? binding.name.text),
      );
    }
  }
}
check(new Set(skillNames).size === skillNames.length, "skill-library selection must be unique");
const schemaModules = await import("../packages/gateway-protocol/src/schema-modules.ts");
const skills: Readonly<Record<string, unknown>> =
  await import("../packages/gateway-protocol/src/schema/skill-library.ts");
for (const name of skillNames) {
  check(
    name.endsWith("Schema") && Object.hasOwn(skills, name),
    `unknown selected skill schema ${name}`,
  );
}
const sources: Readonly<Record<string, unknown>> = {
  ...schemaModules,
  ...Object.fromEntries(skillNames.map((name) => [name, skills[name]])),
};
for (const name of excluded) {
  check(name.endsWith("Schema") && Object.hasOwn(sources, name), `unknown excluded schema ${name}`);
}
const expectedDerived = Object.keys(sources)
  .filter((name) => name.endsWith("Schema") && !excluded.has(name))
  .toSorted()
  .map((name) => name.slice(0, -"Schema".length));
const { DerivedProtocolSchemas } =
  await import("../packages/gateway-protocol/src/schema/protocol-schema-selection.ts");
const { ProtocolSchemas } =
  await import("../packages/gateway-protocol/src/schema/protocol-schemas.ts");
const derived: Readonly<Record<string, unknown>> = DerivedProtocolSchemas;
const registry: Readonly<Record<string, unknown>> = ProtocolSchemas;
check(
  JSON.stringify(Object.keys(derived).toSorted()) === JSON.stringify(expectedDerived.toSorted()),
  "derived registry keys must match canonical schema exports and explicit exclusions",
);
for (const key of Object.keys(derived)) {
  check(
    derived[key] === sources[`${key}Schema`],
    `derived schema ${key} changed its canonical object`,
  );
}
const fragments: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  derived,
  schemaModules.MigrationProtocolSchemas,
  schemaModules.SessionPlacementProtocolSchemas,
];
const expectedKeys: string[] = [];
const seen = new Set<string>();
for (const fragment of fragments) {
  for (const [key, schema] of Object.entries(fragment)) {
    check(!seen.has(key), `duplicate derived/supplemental registry key ${key}`);
    seen.add(key);
    expectedKeys.push(key);
    check(
      Object.hasOwn(registry, key) && registry[key] === schema,
      `registry lost canonical owner ${key}`,
    );
  }
}
check(
  JSON.stringify(Object.keys(registry).toSorted()) === JSON.stringify([...seen].toSorted()),
  "registry must contain exactly the derived and supplemental owner keys",
);
// Keep source-export enumeration separate from supplemental owner order.
check(
  JSON.stringify(Object.keys(derived)) === JSON.stringify(expectedDerived) &&
    JSON.stringify(Object.keys(registry)) === JSON.stringify(expectedKeys),
  "registry must preserve source-export lexical order and supplemental owner order",
);
const typesPath = "packages/gateway-protocol/src/schema/protocol-schema-types.ts";
check(
  parse(typesPath).statements.every(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) ||
      (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly),
  ),
  "registry type grouping must not add a runtime owner or import",
);
const composerSource = read("packages/gateway-protocol/src/schema/protocol-schema-composer.ts");
check(
  !/\.(?:sort|toSorted)\s*\(/u.test(composerSource),
  "schema composer must not sort its fragments",
);
check(
  composerSource.includes("Object.hasOwn(registry, key)"),
  "schema composer must reject duplicate fragment keys",
);

const withoutComments = (source: string) =>
  source
    .replace(/\r\n?/gu, "\n")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .trim();
const schemaModulesSource = withoutComments(
  read("packages/gateway-protocol/src/schema-modules.ts"),
);
const ownerModules = [
  ...schemaModulesSource.matchAll(/^export \* from "\.\/schema\/([^"]+)\.js";$/gmu),
].map(([, moduleName = ""]) => moduleName);
check(
  ownerModules.length === 64 && new Set(ownerModules).size === ownerModules.length,
  "schema-modules.ts must contain one unique 64-module owner list",
);
check(
  schemaModulesSource.split("\n").filter(Boolean).length === ownerModules.length,
  "schema-modules.ts may contain only owner-module exports",
);
check(
  withoutComments(read("packages/gateway-protocol/src/schema.ts")) ===
    'export * from "./schema-modules.js";\nexport * from "./schema/protocol-schemas.js";',
  "schema.ts must remain a schema-modules/protocol-schemas wrapper",
);
check(
  withoutComments(read("packages/gateway-protocol/src/schema-types.ts")) ===
    'export type * from "./schema-modules.js";',
  "schema-types.ts must remain a registry-free schema-modules wrapper",
);

const publicIndexSource = read("packages/gateway-protocol/src/index.ts");
const publicSchemaSource = read("packages/gateway-protocol/src/public-schema.ts");
check(
  publicIndexSource.includes('export * from "./public-schema.js";'),
  "index.ts must expose the reviewed public schema allowlist",
);
check(
  publicSchemaSource.includes('} from "./schema-modules.js";'),
  "public-schema.ts must explicitly export the reviewed public schema allowlist",
);
check(
  !publicSchemaSource.includes('export * from "./schema-modules.js";'),
  "public-schema.ts must not expose every schema module export implicitly",
);
check(
  !fs.existsSync(path.join(repoRoot, "packages/gateway-protocol/src/schema-export-registry.ts")),
  "the public schema allowlist must stay in its canonical public-schema owner",
);

for (const relativePath of [
  "packages/gateway-protocol/src/index.ts",
  "packages/gateway-protocol/src/public-schema.ts",
  "packages/gateway-protocol/src/validator-registry.ts",
]) {
  check(
    !/from "\.\/schema(?:\.js|\/protocol-schema(?:s\.js|-[^"]+))"/u.test(read(relativePath)),
    `${relativePath} must not import the aggregate registry or its implementation`,
  );
}
const pluginSdkGuard = read("scripts/check-plugin-sdk-exports.mts");
check(
  pluginSdkGuard.includes("FORBIDDEN_PUBLIC_PROTOCOL_REGISTRY_RE") &&
    pluginSdkGuard.includes("FORBIDDEN PUBLIC DTS REGISTRY"),
  "plugin SDK declaration checks must reject leaked ProtocolSchemas declarations",
);

if (failures.length) {
  throw new Error(
    failures.map((failure) => `protocol registry check failed: ${failure}`).join("\n"),
  );
}
console.log("protocol registry check passed");
