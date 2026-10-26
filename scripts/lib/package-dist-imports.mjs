// Scans packaged JavaScript for relative imports and missing closure entries.
import { createRequire } from "node:module";
import path from "node:path";
import { visitJavaScriptStatements } from "./javascript-statements.mjs";
const JS_FILE_RE = /\.(?:cjs|js|mjs)$/u;
const TS_FILE_RE = /\.(?:cts|ts|mts)$/u;
const require = createRequire(import.meta.url);

/** Strip types for import analysis only; distribution bytes remain unchanged. */
export function preparePackageDistJavaScript(file, source) {
  return TS_FILE_RE.test(file)
    ? require("esbuild").transformSync(source, {
        loader: "ts",
        target: "esnext",
        sourcefile: file,
        tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
      }).code
    : source;
}

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasRuntimeFileExtension(value, includeTypeScript) {
  const file = path.posix.basename(stripSpecifierSuffix(value));
  return /\.(?:cjs|js|mjs|exe)$/u.test(file) || (includeTypeScript && TS_FILE_RE.test(file));
}

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis[0].value.cooked
    : undefined;
}

function packageJsonsFor(params, files) {
  return (
    params.packageJsons ??
    new Map(
      files
        .filter((file) => params.readText && path.posix.basename(file) === "package.json")
        .map((file) => [file, params.readText(file)]),
    )
  );
}

function sourceTypeFor(importerPath, packageJsons) {
  if (/\.(?:cjs|cts)$/u.test(importerPath)) {
    return "script";
  }
  if (/\.(?:mjs|mts)$/u.test(importerPath)) {
    return "module";
  }
  let directory = path.posix.dirname(importerPath);
  while (true) {
    const manifest = packageJsons.get(path.posix.join(directory, "package.json"));
    if (manifest !== undefined) {
      const type = JSON.parse(manifest).type;
      return type === "module" ? "module" : type === "commonjs" ? "script" : undefined;
    }
    if (directory === "." || directory === "/") {
      return undefined;
    }
    directory = path.posix.dirname(directory);
  }
}

function resolvesCommonJs(importedPath, fileSet, packageJsons) {
  const extensions = ["", ".js", ".json", ".node"];
  const loadFile = (target) => extensions.some((extension) => fileSet.has(target + extension));
  const loadIndex = (directory) =>
    extensions
      .slice(1)
      .some((extension) => fileSet.has(path.posix.join(directory, "index" + extension)));
  if (!importedPath.endsWith("/") && loadFile(importedPath)) {
    return true;
  }
  const manifest = packageJsons.get(path.posix.join(importedPath, "package.json"));
  const main = manifest === undefined ? undefined : JSON.parse(manifest).main;
  if (typeof main === "string" && main) {
    const target = path.posix.join(importedPath, main);
    if (loadFile(target) || loadIndex(target)) {
      return true;
    }
  }
  return loadIndex(importedPath);
}

function appendImportEdges(source, importerPath, imports, sourceType, includeTypeScript) {
  function visit(node) {
    // These leaves cannot contain import edges; avoid allocating property lists for them.
    if (node.type === "Identifier" || node.type === "Literal" || node.type === "TemplateElement") {
      return;
    }
    let kind;
    let specifier;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      specifier = literal(node.source);
    } else if (node.type === "ImportExpression") {
      specifier = literal(node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      kind = "require";
      specifier = literal(node.arguments[0]);
    } else if (
      node.type === "NewExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "URL" &&
      node.arguments.length >= 2
    ) {
      const base = node.arguments[1];
      if (
        base.type === "MemberExpression" &&
        !base.computed &&
        base.property.type === "Identifier" &&
        base.property.name === "url" &&
        base.object.type === "MetaProperty" &&
        base.object.meta.name === "import" &&
        base.object.property.name === "meta"
      ) {
        kind = "import-meta-url";
        specifier = literal(node.arguments[0]);
      }
    }
    if (
      specifier?.startsWith(".") &&
      (kind !== "import-meta-url" || hasRuntimeFileExtension(specifier, includeTypeScript))
    ) {
      const importedPath = path.posix.normalize(
        path.posix.join(
          path.posix.dirname(importerPath),
          kind === "require" ? specifier : stripSpecifierSuffix(specifier),
        ),
      );
      // stageManagedHandoffRuntime copies this entry and stages its private proc-safe
      // closure before launch; this URL belongs to that runtime, not the tarball.
      const stagedNativeUrl =
        kind === "import-meta-url" &&
        importerPath === "dist/managed-handoff-runtime.mjs" &&
        importedPath === "dist/node_modules/@openclaw/proc-safe/dist/identity.js";
      if (!stagedNativeUrl && (kind !== "import-meta-url" || importedPath.startsWith("dist/"))) {
        imports.push({ importerPath, importedPath, ...(kind === "require" ? { kind } : {}) });
      }
    }
    for (const key in node) {
      const value = node[key];
      if (!value || typeof value !== "object") {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            visit(child);
          }
        }
      } else if (typeof value.type === "string") {
        visit(value);
      }
    }
  }
  const scan = (type) =>
    visitJavaScriptStatements(
      source,
      { sourceType: type, allowReturnOutsideFunction: true },
      (statements) => {
        for (const statement of statements) {
          visit(statement);
        }
      },
    );
  if (sourceType) {
    scan(sourceType);
    return;
  }
  // Node detects ESM syntax in .js files without an explicit package type.
  const start = imports.length;
  try {
    scan("script");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    imports.length = start;
    scan("module");
  }
}

/** Collect missing-file errors for relative imports inside package files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const packageJsons = packageJsonsFor(params, files);
  const imports =
    params.imports ?? collectPackageDistImports({ files, readText: params.readText, packageJsons });

  for (const { importerPath, importedPath, kind } of imports) {
    const found =
      kind === "require"
        ? resolvesCommonJs(importedPath, fileSet, packageJsons)
        : fileSet.has(importedPath);
    if (!found) {
      errors.push(`${importerPath} imports missing ${importedPath}`);
    }
  }

  return errors;
}

/** Collect relative dist import edges from package JavaScript files. */
export function collectPackageDistImports(params) {
  const files =
    params.files.length === 1
      ? [normalizePackagePath(params.files[0])]
      : [...new Set(params.files.map(normalizePackagePath))].toSorted((left, right) =>
          left.localeCompare(right),
        );
  const imports = [];
  const packageJsons = packageJsonsFor(params, files);

  for (const importerPath of files) {
    if (
      (!JS_FILE_RE.test(importerPath) &&
        !(params.includeTypeScript && TS_FILE_RE.test(importerPath))) ||
      /(?:^|\/)node_modules\//u.test(importerPath)
    ) {
      continue;
    }
    const source = preparePackageDistJavaScript(importerPath, params.readText(importerPath));
    appendImportEdges(
      source,
      importerPath,
      imports,
      sourceTypeFor(importerPath, packageJsons),
      params.includeTypeScript,
    );
  }

  return imports;
}
