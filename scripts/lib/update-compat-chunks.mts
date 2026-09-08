import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parseReleaseVersion } from "./release-version.mjs";
import {
  isUpdateCompatibilityChunk,
  UPDATE_COMPATIBILITY_CHUNK_HEADER,
} from "./update-compat-contract.mjs";

export { isUpdateCompatibilityChunk } from "./update-compat-contract.mjs";
export const UPDATE_COMPATIBILITY_INVENTORY_FILE = "update-compat-inventory.json";
const HASHED_CHUNK = /-[A-Za-z0-9_-]{8}\.m?js$/;
const POST_SWAP_OWNER = /^src\/(?:cli\/update-cli\/|daemon\/|cli\/runtime-cleanup\.ts$)/;

type UpdateCompatibilityOrigin = { module: string; symbol: string };
type UpdateCompatibilityChunk = {
  path: string;
  imports: Array<{ importer: string; owner: string; exports: string[] }>;
  exports: Array<{ exported: string; origin: UpdateCompatibilityOrigin }>;
};
export type UpdateCompatibilityRelease = {
  version: string;
  buildId: string;
  commit: string;
  integrity: string;
  chunks: UpdateCompatibilityChunk[];
};
export type UpdateCompatibilityInventory = {
  schemaVersion: 1;
  releases: UpdateCompatibilityRelease[];
};

type Binding = { file: string; symbol: string } | { local: string };
type ModuleBinding = {
  file: string;
  symbol: string;
  origin: UpdateCompatibilityOrigin | undefined;
};
type ModuleInfo = {
  imports: Map<string, Binding>;
  exports: Map<string, Binding>;
  stars: string[];
  declarations: Map<string, UpdateCompatibilityOrigin | undefined>;
};

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function moduleFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        // Plugin outputs and installed dependencies are independent runtime graphs.
        if (!["node_modules", "extensions", "plugin-sdk"].includes(entry.name)) {
          visit(file);
        }
      } else if (entry.isFile() && /\.m?js$/.test(entry.name)) {
        files.push(file);
      }
    }
  };
  visit(root);
  return files.toSorted();
}

function ownerAt(source: string, offset: number): string | undefined {
  let owner: string | undefined;
  for (const match of source.matchAll(/^\/\/#region (.+)$/gm)) {
    if (match.index > offset) {
      break;
    }
    owner = match[1];
  }
  return owner;
}

function parseModule(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function namedBinding(node: ts.BindingName): string[] {
  if (ts.isIdentifier(node)) {
    return [node.text];
  }
  return node.elements.flatMap((element) =>
    ts.isBindingElement(element) ? namedBinding(element.name) : [],
  );
}

function inspectModule(file: string, source: string, sourceModule?: string): ModuleInfo {
  const info: ModuleInfo = {
    imports: new Map(),
    exports: new Map(),
    stars: [],
    declarations: new Map(),
  };
  const target = (specifier: string) => {
    const resolved = path.resolve(path.dirname(file), specifier);
    return sourceModule === undefined
      ? resolved
      : resolved.replace(/\.js$/, ".ts").replace(/\.mjs$/, ".mts");
  };
  const regions = [...source.matchAll(/^\/\/#region (.+)$/gm)];
  let regionIndex = 0;
  let regionOwner: string | undefined;
  for (const statement of parseModule(file, source).statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const importedFile = target(statement.moduleSpecifier.text);
      if (clause?.name) {
        info.imports.set(clause.name.text, { file: importedFile, symbol: "default" });
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          info.imports.set(element.name.text, {
            file: importedFile,
            symbol: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      const from =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          ? target(statement.moduleSpecifier.text)
          : undefined;
      if (!statement.exportClause && from) {
        info.stars.push(from);
      }
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const symbol = (element.propertyName ?? element.name).text;
          info.exports.set(element.name.text, from ? { file: from, symbol } : { local: symbol });
        }
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
        ts.canHaveModifiers(statement) &&
        ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
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

class ModuleGraph {
  private modules = new Map<string, ModuleInfo>();
  private sourceDir: string | undefined;

  constructor(sourceDir?: string) {
    this.sourceDir = sourceDir;
  }

  info(file: string): ModuleInfo {
    let info = this.modules.get(file);
    if (!info) {
      info = inspectModule(
        file,
        fs.readFileSync(file, "utf8"),
        this.sourceDir === undefined ? undefined : portable(path.relative(this.sourceDir, file)),
      );
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
    return info.declarations.has(symbol)
      ? [{ file, symbol, origin: info.declarations.get(symbol) }]
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
    if (symbol === "default") {
      return [];
    }
    const matches = new Map<string, ModuleBinding>();
    for (const star of info.stars) {
      for (const resolved of this.resolveExport(star, symbol, next)) {
        // ESM compares declaration bindings, not their source-map annotations.
        matches.set(`${resolved.file}:${resolved.symbol}`, resolved);
      }
    }
    return [...matches.values()];
  }

  private sourceOrigin(
    file: string,
    symbol: string,
    bindings: ModuleBinding[],
  ): UpdateCompatibilityOrigin | undefined {
    if (bindings.length > 1) {
      throw new Error(
        `Ambiguous export ${file}:${symbol}; conflicting sources: ${bindings
          .map((binding) => `${binding.file}:${binding.symbol}`)
          .toSorted()
          .join(", ")}`,
      );
    }
    return bindings[0]?.origin;
  }

  origin(file: string, symbol: string): UpdateCompatibilityOrigin | undefined {
    return this.sourceOrigin(file, symbol, this.resolveExport(file, symbol));
  }

  localOrigin(file: string, symbol: string): UpdateCompatibilityOrigin | undefined {
    return this.sourceOrigin(file, symbol, this.resolveLocal(file, symbol, new Set()));
  }
}

function consumedExports(node: ts.CallExpression): string[] | undefined {
  let expression: ts.Node = node;
  let awaited = false;
  while (
    ts.isAwaitExpression(expression.parent) ||
    ts.isParenthesizedExpression(expression.parent)
  ) {
    awaited ||= ts.isAwaitExpression(expression.parent);
    expression = expression.parent;
  }
  // A direct import() is a Promise; its properties are not namespace exports.
  if (!awaited) {
    return undefined;
  }
  const parent = expression.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === expression) {
    return [parent.name.text];
  }
  if (
    ts.isElementAccessExpression(parent) &&
    parent.expression === expression &&
    ts.isStringLiteralLike(parent.argumentExpression)
  ) {
    return [parent.argumentExpression.text];
  }
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === expression &&
    ts.isObjectBindingPattern(parent.name)
  ) {
    if (
      parent.name.elements.some(
        (element) =>
          element.dotDotDotToken || !ts.isIdentifier(element.propertyName ?? element.name),
      )
    ) {
      return undefined;
    }
    return parent.name.elements.map((element) => (element.propertyName ?? element.name).getText());
  }
  return undefined;
}

/** Record the package's emitted imports, without executing any package code. */
export function recordUpdateCompatibilityRelease(params: {
  packageDir: string;
  integrity: string;
}): UpdateCompatibilityRelease {
  const packageDir = path.resolve(params.packageDir);
  const distDir = path.join(packageDir, "dist");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const build = JSON.parse(fs.readFileSync(path.join(distDir, "build-info.json"), "utf8"));
  if (
    packageJson.name !== "openclaw" ||
    packageJson.version !== build.version ||
    typeof build.buildId !== "string" ||
    typeof build.commit !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+=*$/.test(params.integrity)
  ) {
    throw new Error(
      "Update compatibility inventory requires an OpenClaw release build and npm SHA-512 integrity",
    );
  }
  const graph = new ModuleGraph();
  const chunks = new Map<string, UpdateCompatibilityChunk>();
  for (const file of moduleFiles(distDir)) {
    const source = fs.readFileSync(file, "utf8");
    if (
      !source.includes("import(") ||
      ![...source.matchAll(/^\/\/#region (.+)$/gm)].some(
        ([, owner]) => owner !== undefined && POST_SWAP_OWNER.test(owner),
      )
    ) {
      continue;
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const owner = ownerAt(source, node.getStart());
        // The wizard's only lazy command import starts the update, before replacement.
        if (owner && POST_SWAP_OWNER.test(owner) && owner !== "src/cli/update-cli/wizard.ts") {
          const specifier = node.arguments[0];
          if (!specifier || !ts.isStringLiteralLike(specifier)) {
            throw new Error(`Nonliteral post-swap import in ${file}: ${node.getText()}`);
          }
          if (specifier.text.startsWith(".")) {
            const target = path.resolve(path.dirname(file), specifier.text);
            const relative = portable(path.relative(distDir, target));
            if (relative.startsWith("../")) {
              throw new Error(`Post-swap import escapes dist: ${relative}`);
            }
            const names = consumedExports(node) ?? graph.names(target);
            const chunk = chunks.get(relative) ?? { path: relative, imports: [], exports: [] };
            chunk.imports.push({
              importer: portable(path.relative(distDir, file)),
              owner,
              exports: names.toSorted(),
            });
            for (const exported of names) {
              if (chunk.exports.some((entry) => entry.exported === exported)) {
                continue;
              }
              const origin = graph.origin(target, exported);
              if (!origin) {
                throw new Error(
                  `Cannot trace ${relative} export ${exported} to its release source`,
                );
              }
              chunk.exports.push({ exported, origin });
            }
            chunks.set(relative, chunk);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parseModule(file, source));
  }
  return {
    version: packageJson.version,
    buildId: build.buildId,
    commit: build.commit,
    integrity: params.integrity,
    chunks: [...chunks.values()]
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .map((chunk) => ({
        path: chunk.path,
        imports: chunk.imports,
        exports: chunk.exports.toSorted((a, b) => a.exported.localeCompare(b.exported)),
      })),
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeRelative(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\\") &&
    !path.posix.isAbsolute(value) &&
    !value.split("/").includes("..")
  );
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/.test(value);
}

export function readUpdateCompatibilityInventory(file: string): UpdateCompatibilityInventory {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parseUpdateCompatibilityInventory(value, file);
}

export function parseUpdateCompatibilityInventory(
  value: unknown,
  file = "update compatibility inventory",
): UpdateCompatibilityInventory {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.releases) ||
    value.releases.length < 1
  ) {
    throw new Error(`Invalid update compatibility inventory: ${file}`);
  }
  const releases: UpdateCompatibilityRelease[] = value.releases.map((release) => {
    if (
      !object(release) ||
      typeof release.version !== "string" ||
      typeof release.buildId !== "string" ||
      typeof release.commit !== "string" ||
      typeof release.integrity !== "string" ||
      !Array.isArray(release.chunks)
    ) {
      throw new Error(`Invalid release in ${file}`);
    }
    const chunks: UpdateCompatibilityChunk[] = release.chunks.map((chunk) => {
      if (
        !object(chunk) ||
        !safeRelative(chunk.path) ||
        !/\.m?js$/.test(chunk.path) ||
        !Array.isArray(chunk.imports) ||
        !Array.isArray(chunk.exports) ||
        chunk.imports.length === 0 ||
        chunk.exports.length === 0
      ) {
        throw new Error(`Invalid chunk in ${file}`);
      }
      const imports = chunk.imports.map((entry) => {
        if (
          !object(entry) ||
          !safeRelative(entry.importer) ||
          !safeRelative(entry.owner) ||
          !Array.isArray(entry.exports) ||
          !entry.exports.every(identifier)
        ) {
          throw new Error(`Invalid import in ${file}`);
        }
        return { importer: entry.importer, owner: entry.owner, exports: entry.exports };
      });
      const exports = chunk.exports.map((entry) => {
        if (
          !object(entry) ||
          !identifier(entry.exported) ||
          !object(entry.origin) ||
          !safeRelative(entry.origin.module) ||
          !identifier(entry.origin.symbol)
        ) {
          throw new Error(`Invalid export in ${file}`);
        }
        return {
          exported: entry.exported,
          origin: { module: entry.origin.module, symbol: entry.origin.symbol },
        };
      });
      for (const entry of imports) {
        for (const name of entry.exports) {
          if (!exports.some((exported) => exported.exported === name)) {
            throw new Error(`Missing recorded export ${chunk.path}:${name} in ${file}`);
          }
        }
      }
      return { path: chunk.path, imports, exports };
    });
    return {
      version: release.version,
      buildId: release.buildId,
      commit: release.commit,
      integrity: release.integrity,
      chunks,
    };
  });
  const versions = new Set<string>();
  for (const release of releases) {
    if (
      parseReleaseVersion(release.version)?.version !== release.version ||
      versions.has(release.version)
    ) {
      throw new Error(`Invalid or duplicate release version ${release.version} in ${file}`);
    }
    versions.add(release.version);
  }
  collectRequiredCompatibilityChunks(releases);
  return { schemaVersion: 1, releases };
}

function collectRequiredCompatibilityChunks(
  releases: UpdateCompatibilityRelease[],
): UpdateCompatibilityChunk[] {
  const requiredByPath = new Map<string, UpdateCompatibilityChunk>();
  const exportVersions = new Map<string, string>();
  for (const release of releases) {
    for (const chunk of release.chunks) {
      const merged = requiredByPath.get(chunk.path) ?? {
        path: chunk.path,
        imports: [],
        exports: [],
      };
      for (const entry of chunk.exports) {
        const previous = merged.exports.find((candidate) => candidate.exported === entry.exported);
        const key = `${chunk.path}:${entry.exported}`;
        if (
          previous &&
          (previous.origin.module !== entry.origin.module ||
            previous.origin.symbol !== entry.origin.symbol)
        ) {
          throw new Error(
            `Release inventories disagree about ${key}: ${exportVersions.get(key)} uses ${previous.origin.module}:${previous.origin.symbol}; ${release.version} uses ${entry.origin.module}:${entry.origin.symbol}`,
          );
        }
        if (!previous) {
          merged.exports.push(entry);
          exportVersions.set(key, release.version);
        }
      }
      requiredByPath.set(chunk.path, merged);
    }
  }
  return [...requiredByPath.values()];
}

export function listUpdateCompatibilityChunkPaths(
  inventory: UpdateCompatibilityInventory,
): string[] {
  return [
    ...new Set(
      inventory.releases.flatMap((release) =>
        release.chunks.filter((chunk) => HASHED_CHUNK.test(chunk.path)).map((chunk) => chunk.path),
      ),
    ),
  ].toSorted();
}

/** Follow the old owner's current lexical binding when its implementation moves. */
function currentOrigin(
  origin: UpdateCompatibilityOrigin,
  sourceDir: string,
  graph: ModuleGraph,
): UpdateCompatibilityOrigin {
  const file = path.join(sourceDir, origin.module);
  if (!fs.existsSync(file)) {
    return origin;
  }
  const resolved = graph.localOrigin(file, origin.symbol) ?? graph.origin(file, origin.symbol);
  if (resolved) {
    return resolved;
  }
  const info = graph.info(file);
  if (info.imports.has(origin.symbol) || info.exports.has(origin.symbol)) {
    throw new Error(`Cannot resolve current source binding ${origin.module}:${origin.symbol}`);
  }
  return origin;
}

/** Generate only recorded hashed paths; existing public entrypoints remain build-owned. */
export function writeUpdateCompatibilityChunks(params: {
  distDir: string;
  sourceDir: string;
  inventory: UpdateCompatibilityInventory;
}): string[] {
  const distDir = path.resolve(params.distDir);
  const graph = new ModuleGraph();
  const sourceGraph = new ModuleGraph(params.sourceDir);
  const required = collectRequiredCompatibilityChunks(params.inventory.releases);
  const origins = new Map<string, UpdateCompatibilityOrigin>();
  for (const chunk of required) {
    for (const entry of chunk.exports) {
      const origin = currentOrigin(entry.origin, params.sourceDir, sourceGraph);
      origins.set(`${entry.origin.module}:${entry.origin.symbol}`, origin);
    }
  }
  const ownerModules = new Set([...origins.values()].map((origin) => origin.module));
  const candidates = new Map<string, Array<{ file: string; exported: string }>>();
  for (const file of moduleFiles(distDir)) {
    const relative = portable(path.relative(distDir, file));
    if (relative.startsWith("extensions/") || relative.startsWith("plugin-sdk/")) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (
      isUpdateCompatibilityChunk(source) ||
      ![...source.matchAll(/^\/\/#region (.+)$/gm)].some(
        ([, owner]) => owner !== undefined && ownerModules.has(owner),
      )
    ) {
      continue;
    }
    for (const exported of graph.names(file)) {
      const origin = graph.origin(file, exported);
      if (!origin) {
        continue;
      }
      const key = `${origin.module}:${origin.symbol}`;
      const matches = candidates.get(key) ?? [];
      matches.push({ file: relative, exported });
      candidates.set(key, matches);
    }
  }
  const outputs = new Map<string, string>();
  for (const chunk of required) {
    const destination = path.join(distDir, chunk.path);
    const existing =
      fs.existsSync(destination) &&
      !isUpdateCompatibilityChunk(fs.readFileSync(destination, "utf8"));
    if (existing) {
      const names = graph.names(destination);
      for (const entry of chunk.exports) {
        if (!names.includes(entry.exported)) {
          throw new Error(
            `Existing update compatibility target ${chunk.path} lacks ${entry.exported}`,
          );
        }
        if (HASHED_CHUNK.test(chunk.path)) {
          const actual = graph.origin(destination, entry.exported);
          const expected = origins.get(`${entry.origin.module}:${entry.origin.symbol}`)!;
          if (actual?.module !== expected.module || actual?.symbol !== expected.symbol) {
            throw new Error(
              `Existing update compatibility target ${chunk.path}:${entry.exported} has no equivalent source origin`,
            );
          }
        }
      }
      continue;
    }
    if (!HASHED_CHUNK.test(chunk.path)) {
      throw new Error(
        `Missing public update compatibility target ${chunk.path}; restore its canonical build output`,
      );
    }
    const lines = [UPDATE_COMPATIBILITY_CHUNK_HEADER];
    for (const entry of chunk.exports) {
      const origin = origins.get(`${entry.origin.module}:${entry.origin.symbol}`)!;
      const matches = candidates.get(`${origin.module}:${origin.symbol}`) ?? [];
      const match = matches[0];
      if (matches.length !== 1 || !match) {
        throw new Error(
          `Cannot bridge ${chunk.path} export ${entry.exported} (${entry.origin.module}:${entry.origin.symbol}): ${matches.length ? `ambiguous current exports ${matches.map((candidate) => `${candidate.file}:${candidate.exported}`).join(", ")}` : "no equivalent current export"}`,
        );
      }
      let specifier = portable(
        path.relative(path.dirname(destination), path.join(distDir, match.file)),
      );
      if (!specifier.startsWith(".")) {
        specifier = `./${specifier}`;
      }
      lines.push(
        `export { ${match.exported} as ${entry.exported} } from ${JSON.stringify(specifier)};`,
      );
    }
    const contents = `${lines.join("\n")}\n`;
    outputs.set(chunk.path, contents);
  }
  // Finish all mappings before writing any compatibility output.
  for (const [relative, contents] of outputs) {
    const destination = path.join(distDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (!fs.existsSync(destination) || fs.readFileSync(destination, "utf8") !== contents) {
      fs.writeFileSync(destination, contents);
    }
  }
  fs.writeFileSync(
    path.join(distDir, UPDATE_COMPATIBILITY_INVENTORY_FILE),
    `${JSON.stringify(params.inventory, null, 2)}\n`,
  );
  return [...outputs.keys()].toSorted();
}
