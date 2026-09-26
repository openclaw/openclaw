import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import type { NativeTypeScriptParser } from "./native-typescript.mts";
import { buildUpdateConfigRuntimeAlias } from "./update-config-runtime-compat.mts";

export type UpdateCompatibilityOrigin = { module: string; symbol: string };

type Binding =
  | { file: string; symbol: string }
  | { external: string; symbol: string }
  | { namespace: string }
  | { local: string };
type ModuleBinding =
  | { kind: "file"; file: string; symbol: string; origin: UpdateCompatibilityOrigin | undefined }
  | { kind: "external"; external: string; symbol: string; origin: undefined }
  | { kind: "namespace"; namespace: string; symbol: "*"; origin: undefined };
type ModuleInfo = {
  imports: Map<string, Binding>;
  exports: Map<string, Binding>;
  stars: string[];
  declarations: Map<string, UpdateCompatibilityOrigin | undefined>;
};

function namedBinding(node: ts.BindingName): string[] {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  return node.elements.flatMap((element) =>
    ts.isBindingElement(element) && element.name ? namedBinding(element.name) : [],
  );
}

function inspectModule(file: string, sourceFile: ts.SourceFile, sourceModule?: string): ModuleInfo {
  const info: ModuleInfo = {
    imports: new Map(),
    exports: new Map(),
    stars: [],
    declarations: new Map(),
  };
  const target = (specifier: string) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
      return undefined;
    }
    const resolved = path.resolve(path.dirname(file), specifier);
    return sourceModule === undefined
      ? resolved
      : resolved.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts");
  };
  const binding = (specifier: string, symbol: string): Binding => {
    const resolvedFile = target(specifier);
    return resolvedFile ? { file: resolvedFile, symbol } : { external: specifier, symbol };
  };
  const regions = [...sourceFile.text.matchAll(/^\/\/#region (.+)$/gm)];
  let regionIndex = 0;
  let regionOwner: string | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.name) {
        info.imports.set(clause.name.text, binding(statement.moduleSpecifier.text, "default"));
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          info.imports.set(
            element.name.text,
            binding(statement.moduleSpecifier.text, (element.propertyName ?? element.name).text),
          );
        }
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        info.imports.set(clause.namedBindings.name.text, {
          namespace: target(statement.moduleSpecifier.text) ?? statement.moduleSpecifier.text,
        });
      }
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (!statement.exportClause && specifier) {
        const from = target(specifier);
        if (!from) {
          throw new Error(
            `Cannot enumerate external wildcard exports from ${specifier} in ${file}`,
          );
        }
        info.stars.push(from);
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const symbol = (element.propertyName ?? element.name).text;
          info.exports.set(
            element.name.text,
            specifier ? binding(specifier, symbol) : { local: symbol },
          );
        }
      } else if (
        specifier &&
        statement.exportClause &&
        ts.isNamespaceExport(statement.exportClause)
      ) {
        info.exports.set(statement.exportClause.name.text, {
          namespace: target(specifier) ?? specifier,
        });
      }
    }
    const names = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.flatMap((declaration) =>
          namedBinding(declaration.name),
        )
      : (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name
        ? [statement.name.text]
        : [];
    while (regionIndex < regions.length) {
      const region = regions[regionIndex];
      if (!region || region.index >= statement.getStart()) {
        break;
      }
      regionOwner = region[1];
      regionIndex += 1;
    }
    const owner = sourceModule ?? regionOwner;
    for (const symbol of names) {
      info.declarations.set(symbol, owner ? { module: owner, symbol } : undefined);
      if (
        (ts.isVariableStatement(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        info.exports.set(symbol, { local: symbol });
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      info.exports.set("default", { local: statement.expression.text });
    }
  }
  return info;
}

function moduleBindingKey(binding: ModuleBinding): string {
  const target =
    binding.kind === "file"
      ? binding.file
      : binding.kind === "external"
        ? `external:${binding.external}`
        : `namespace:${binding.namespace}`;
  return `${target}:${binding.symbol}`;
}

export class ModuleGraph {
  private modules = new Map<string, ModuleInfo>();
  private sourceDir: string | undefined;
  private parser: NativeTypeScriptParser;

  constructor(parser: NativeTypeScriptParser, sourceDir?: string) {
    this.parser = parser;
    this.sourceDir = sourceDir;
  }

  info(file: string): ModuleInfo {
    let info = this.modules.get(file);
    if (!info) {
      const source = fs.readFileSync(file, "utf8");
      info = inspectModule(
        file,
        this.parser.parseSourceFile(file, source),
        this.sourceDir === undefined
          ? undefined
          : path.relative(this.sourceDir, file).split(path.sep).join("/"),
      );
      const delegatedTarget = source.match(
        /^const target = new URL\("\.\/([\w.-]+\.m?js)", import\.meta\.url\)\.href;$/m,
      )?.[1];
      if (
        this.sourceDir === undefined &&
        path.basename(file) === "io.runtime.js" &&
        delegatedTarget
      ) {
        const targetFile = path.join(path.dirname(file), delegatedTarget);
        const targetSource = fs.readFileSync(targetFile, "utf8");
        // Only the complete generated read contract proves delegation. Unknown wrappers
        // must still fail provenance tracing; never execute a release to discover exports.
        if (
          source ===
          buildUpdateConfigRuntimeAlias(
            delegatedTarget,
            this.parser.parseSourceFile(targetFile, targetSource),
          )
        ) {
          for (const name of info.exports.keys()) {
            info.exports.set(name, { file: targetFile, symbol: name });
          }
        }
      }
      this.modules.set(file, info);
    }
    return info;
  }

  private exportedNames(file: string, seen = new Set<string>()): string[] {
    if (seen.has(file)) {
      return [];
    }
    seen.add(file);
    const info = this.info(file);
    return [
      ...new Set([
        ...info.exports.keys(),
        ...info.stars.flatMap((star) =>
          this.exportedNames(star, seen).filter((name) => name !== "default"),
        ),
      ]),
    ].toSorted();
  }

  names(file: string): string[] {
    return this.exportedNames(file).filter((name) => this.resolveExport(file, name).length === 1);
  }

  private resolveLocal(file: string, symbol: string, seen: Set<string>): ModuleBinding[] {
    const key = `local:${file}:${symbol}`;
    if (seen.has(key)) {
      return [];
    }
    const next = new Set(seen).add(key);
    const info = this.info(file);
    const imported = info.imports.get(symbol);
    if (imported && "file" in imported) {
      return this.resolveExport(imported.file, imported.symbol, next);
    }
    if (imported && "external" in imported) {
      return [{ kind: "external", ...imported, origin: undefined }];
    }
    if (imported && "namespace" in imported) {
      return [{ kind: "namespace", ...imported, symbol: "*", origin: undefined }];
    }
    return info.declarations.has(symbol)
      ? [{ kind: "file", file, symbol, origin: info.declarations.get(symbol) }]
      : [];
  }

  private resolveExport(file: string, symbol: string, seen = new Set<string>()): ModuleBinding[] {
    const key = `export:${file}:${symbol}`;
    if (seen.has(key)) {
      return [];
    }
    const next = new Set(seen).add(key);
    const info = this.info(file);
    const binding = info.exports.get(symbol);
    if (binding && "file" in binding) {
      return this.resolveExport(binding.file, binding.symbol, next);
    }
    if (binding && "local" in binding) {
      return this.resolveLocal(file, binding.local, next);
    }
    if (binding && "external" in binding) {
      return [{ kind: "external", ...binding, origin: undefined }];
    }
    if (binding && "namespace" in binding) {
      return [{ kind: "namespace", ...binding, symbol: "*", origin: undefined }];
    }
    if (symbol === "default") {
      return [];
    }
    const matches = new Map<string, ModuleBinding>();
    for (const star of info.stars) {
      for (const resolved of this.resolveExport(star, symbol, next)) {
        // ESM compares declaration bindings, not their source-map annotations.
        matches.set(moduleBindingKey(resolved), resolved);
      }
    }
    return [...matches.values()];
  }

  private singleBinding(
    file: string,
    symbol: string,
    bindings: ModuleBinding[],
  ): ModuleBinding | undefined {
    if (bindings.length > 1) {
      throw new Error(
        `Ambiguous export ${file}:${symbol}; conflicting sources: ${bindings
          .map(moduleBindingKey)
          .toSorted()
          .join(", ")}`,
      );
    }
    return bindings[0];
  }

  binding(file: string, symbol: string): ModuleBinding | undefined {
    return this.singleBinding(file, symbol, this.resolveExport(file, symbol));
  }

  origin(file: string, symbol: string): UpdateCompatibilityOrigin | undefined {
    return this.binding(file, symbol)?.origin;
  }

  localOrigin(file: string, symbol: string): UpdateCompatibilityOrigin | undefined {
    return this.singleBinding(file, symbol, this.resolveLocal(file, symbol, new Set()))?.origin;
  }
}
