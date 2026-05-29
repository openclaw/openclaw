import path from "node:path";

const JS_DIST_FILE_RE = /^dist\/.*\.(?:cjs|js|mjs)$/u;

function normalizePackagePath(value) {
  return value.replace(/\\/gu, "/").replace(/^package\//u, "");
}

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function resolveDistImportPath(importerPath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const stripped = stripSpecifierSuffix(specifier);
  if (!stripped) {
    return null;
  }
  return path.posix.normalize(path.posix.join(path.posix.dirname(importerPath), stripped));
}

function isWordBoundaryChar(char) {
  return char === undefined || !/[\w$]/u.test(char);
}

function matchesKeywordAt(source, index, keyword) {
  if (source.slice(index, index + keyword.length) !== keyword) {
    return false;
  }
  return (
    isWordBoundaryChar(source[index - 1]) && isWordBoundaryChar(source[index + keyword.length])
  );
}

// Returns the next character that is not whitespace and not inside a comment,
// along with its index. Used to disambiguate `import` (statement) from
// `import.meta` (meta-property access).
function peekNextSignificant(source, start) {
  let cursor = start;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      cursor += 1;
      continue;
    }
    if (ch === "/" && source[cursor + 1] === "/") {
      cursor += 2;
      while (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
        cursor += 1;
      }
      continue;
    }
    if (ch === "/" && source[cursor + 1] === "*") {
      cursor += 2;
      while (
        cursor < source.length - 1 &&
        !(source[cursor] === "*" && source[cursor + 1] === "/")
      ) {
        cursor += 1;
      }
      cursor += 2;
      continue;
    }
    return { char: ch, index: cursor };
  }
  return { char: undefined, index: cursor };
}

function isStaticImportDeclarationStart(char) {
  if (char === undefined) {
    return false;
  }
  // Valid static import starts: import "./x", import { }, import * as, import foo.
  // Reject `import:` (object key) and other non-declaration followers.
  return char === '"' || char === "'" || char === "{" || char === "*" || /[A-Za-z_$]/u.test(char);
}

// Walks the source with a forward state machine and collects the specifier of
// every static `import`/`export ... from` and dynamic `import(...)` statement.
// Replaces the previous reverse-scan approach in `findStatementStart`, which
// treated the closing `}` of a destructured import (`import { x } from "..."`)
// as a statement terminator and silently dropped those imports.
//
// State semantics:
//   null                  : top-level; looking for `import` / `export` keyword.
//   import                : inside a static import declaration; the next string
//                           literal is the specifier. Only entered for valid
//                           declaration shapes (not `import:` object keys).
//                           `import.meta` and non-literal `import(...)` are
//                           filtered before this state is entered.
//   export                : just saw `export` keyword; waiting to see whether
//                           this is a re-export (`*` or `{ ... }`) or a local
//                           declaration (`const` / `function` / identifier /
//                           etc.). Local declarations reset to null.
//   export-ns             : saw `export *`; accepts `as <id>` and `from`.
//   export-list           : saw `export {`; tracking brace depth until the
//                           list closes, then promotes to from-eligible.
//   export-from-eligible  : the export clause structurally allows `from`. Only
//                           the keyword `from` promotes to specifier-pending;
//                           anything else (other identifiers, `;`) resets.
//   specifier-pending     : the next string literal is the re-export specifier.
function collectImportSpecifiers(source) {
  const specifiers = [];
  let inBlockComment = false;
  let inLineComment = false;
  let stmtState = null;
  let exportListDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];

    if (inBlockComment) {
      if (ch === "*" && source[index + 1] === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inLineComment) {
      if (ch === "\n" || ch === "\r") {
        inLineComment = false;
      }
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (ch === ";") {
      stmtState = null;
      exportListDepth = 0;
      continue;
    }

    if (stmtState === "export-list") {
      if (ch === "{") {
        exportListDepth += 1;
      } else if (ch === "}") {
        exportListDepth -= 1;
        if (exportListDepth === 0) {
          stmtState = "export-from-eligible";
        }
      }
      continue;
    }

    if (stmtState === "export") {
      if (ch === "*") {
        stmtState = "export-ns";
        continue;
      }
      if (ch === "{") {
        stmtState = "export-list";
        exportListDepth = 1;
        continue;
      }
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        continue;
      }
      // Anything else after `export` (identifier, `default`, `(`, etc.) is
      // a local declaration. It can still legally contain a dynamic
      // `import(...)` or another `export` later on a separate statement, so
      // reset to null rather than entering a dedicated declaration state.
      stmtState = null;
      // Fall through so this character is re-evaluated below.
    }

    if (stmtState === "export-ns" && matchesKeywordAt(source, index, "from")) {
      stmtState = "specifier-pending";
      index += "from".length - 1;
      continue;
    }

    if (stmtState === "export-from-eligible") {
      if (matchesKeywordAt(source, index, "from")) {
        stmtState = "specifier-pending";
        index += "from".length - 1;
        continue;
      }
      // A non-`from` word-boundary identifier here means the export list
      // was a local export (`export { x };`) and the `from` keyword will
      // never come. Reset before the identifier could be mistaken for one.
      if (/[A-Za-z_$]/u.test(ch) && isWordBoundaryChar(source[index - 1])) {
        stmtState = null;
        // Fall through to re-evaluate this token from a clean state.
      }
    }

    if (stmtState === null) {
      if (matchesKeywordAt(source, index, "import")) {
        const peek = peekNextSignificant(source, index + "import".length);
        // `import.meta` meta-property access is not a statement; skip past
        // the keyword without entering import state.
        if (peek.char === ".") {
          index += "import".length - 1;
          continue;
        }
        if (peek.char === "(") {
          const argPeek = peekNextSignificant(source, peek.index + 1);
          if (argPeek.char === '"' || argPeek.char === "'") {
            stmtState = "import";
            index = argPeek.index - 1;
            continue;
          }
          if (argPeek.char === "`") {
            let cursor = argPeek.index + 1;
            while (cursor < source.length) {
              const c = source[cursor];
              if (c === "\\") {
                cursor += 2;
                continue;
              }
              if (c === "`") {
                break;
              }
              cursor += 1;
            }
            index = cursor >= source.length ? source.length - 1 : cursor;
            continue;
          }
          index += "import".length - 1;
          continue;
        }
        if (isStaticImportDeclarationStart(peek.char)) {
          stmtState = "import";
        }
        index += "import".length - 1;
        continue;
      }
      if (matchesKeywordAt(source, index, "export")) {
        stmtState = "export";
        index += "export".length - 1;
        continue;
      }
    }

    if (ch !== '"' && ch !== "'" && ch !== "`") {
      continue;
    }

    if (ch === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        const c = source[cursor];
        if (c === "\\") {
          cursor += 2;
          continue;
        }
        if (c === "$" && source[cursor + 1] === "{") {
          const innerStart = cursor + 2;
          let depth = 1;
          cursor += 2;
          while (cursor < source.length && depth > 0) {
            if (source[cursor] === "{") {
              depth += 1;
            } else if (source[cursor] === "}") {
              depth -= 1;
            }
            cursor += 1;
          }
          if (depth === 0) {
            specifiers.push(...collectImportSpecifiers(source.slice(innerStart, cursor - 1)));
          }
          continue;
        }
        if (c === "`") {
          break;
        }
        cursor += 1;
      }
      if (cursor >= source.length) {
        break;
      }
      index = cursor;
      if (stmtState === "import" || stmtState === "specifier-pending") {
        // A template literal after `import` / `from` is invalid ESM; drop
        // the pending state so the next string literal is not mis-captured.
        stmtState = null;
      }
      continue;
    }

    const quote = ch;
    let cursor = index + 1;
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        value += source.slice(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
      if (char === quote) {
        break;
      }
      value += char;
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }

    if (stmtState === "import" || stmtState === "specifier-pending") {
      if (value.startsWith(".")) {
        specifiers.push(value);
      }
      // Only the first string literal after the keyword is the specifier.
      stmtState = null;
    }

    index = cursor;
  }
  return specifiers;
}

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

export function collectPackageDistImports(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const imports = [];

  for (const importerPath of files.toSorted((left, right) => left.localeCompare(right))) {
    if (!JS_DIST_FILE_RE.test(importerPath) || importerPath.includes("/node_modules/")) {
      continue;
    }
    const source = params.readText(importerPath);
    for (const specifier of collectImportSpecifiers(source)) {
      const importedPath = resolveDistImportPath(importerPath, specifier);
      if (!importedPath) {
        continue;
      }
      imports.push({ importerPath, importedPath });
    }
  }

  return imports;
}

export function expandPackageDistImportClosure(params) {
  const files = [...new Set(params.files.map(normalizePackagePath))];
  const fileSet = new Set(files);
  const expectedSet = new Set(params.seedFiles.map(normalizePackagePath));
  const imports = params.imports ?? collectPackageDistImports({ files, readText: params.readText });
  const importsByImporter = new Map();
  for (const { importerPath, importedPath } of imports) {
    const importerImports = importsByImporter.get(importerPath) ?? [];
    importerImports.push(importedPath);
    importsByImporter.set(importerPath, importerImports);
  }

  const queue = [...expectedSet].filter((file) => fileSet.has(file));
  for (let index = 0; index < queue.length; index += 1) {
    const importerPath = queue[index];
    for (const importedPath of importsByImporter.get(importerPath) ?? []) {
      if (fileSet.has(importedPath) && !expectedSet.has(importedPath)) {
        expectedSet.add(importedPath);
        queue.push(importedPath);
      }
    }
  }

  return [...expectedSet].toSorted((left, right) => left.localeCompare(right));
}
