// Scans packaged JavaScript for relative imports and missing closure entries.
import path from "node:path";
import { parse } from "acorn";
const JS_FILE_RE = /\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function hasJavaScriptFileExtension(value) {
  return /\.(?:cjs|js|mjs)$/u.test(path.posix.basename(stripSpecifierSuffix(value)));
}

function literal(node) {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return node?.type === "TemplateLiteral" && node.expressions.length === 0
    ? node.quasis[0].value.cooked
    : undefined;
}

function appendImportEdges(source, importerPath, imports) {
  const program = parse(source, {
    ecmaVersion: "latest",
    sourceType: importerPath.endsWith(".cjs") ? "script" : "module",
    allowReturnOutsideFunction: true,
  });
  function visit(node) {
    let kind;
    let specifier;
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
    ) {
      specifier = literal(node.source);
    } else if (node.type === "ImportExpression") {
      specifier = literal(node.source);
    } else if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
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
      (kind !== "import-meta-url" || hasJavaScriptFileExtension(specifier))
    ) {
      const importedPath = path.posix.normalize(
        path.posix.join(path.posix.dirname(importerPath), stripSpecifierSuffix(specifier)),
      );
      // stageManagedHandoffRuntime copies this entry and stages its private Koffi
      // closure before launch; this URL belongs to that runtime, not the tarball.
      const stagedNativeUrl =
        kind === "import-meta-url" &&
        importerPath === "dist/managed-handoff-runtime.mjs" &&
        importedPath === "dist/node_modules/koffi/indirect.cjs";
      if (!stagedNativeUrl && (kind !== "import-meta-url" || importedPath.startsWith("dist/"))) {
        imports.push({ importerPath, importedPath });
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (child && typeof child.type === "string") {
            visit(child);
          }
        }
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }
  }
  visit(program);
}

/** Collect missing-file errors for relative imports inside package files. */
export function collectPackageDistImportErrors(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const errors = [];
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });

  for (const { importerPath, importedPath } of imports) {
    if (!fileSet.has(importedPath)) {
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

  for (const importerPath of files) {
    if (!JS_FILE_RE.test(importerPath) || /(?:^|\/)node_modules\//u.test(importerPath)) {
      continue;
    }
    const source = params.readText(importerPath);
    appendImportEdges(source, importerPath, imports);
  }

  return imports;
}
