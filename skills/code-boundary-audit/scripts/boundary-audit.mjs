#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const ts = await loadTypeScript();

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  "out",
]);

async function loadTypeScript() {
  try {
    const mod = await import("typescript");
    return mod.default ?? mod;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error("TypeScript package is required for AST boundary audit.");
    console.error("Install it in the target repository (example: `pnpm add -D typescript`).");
    console.error(`Loader error: ${details}`);
    process.exit(2);
  }
}

function usage() {
  console.log(`Usage:
  boundary-audit.mjs callers --symbol <name> [--root <path>] [--include-tests]
  boundary-audit.mjs contracts --config <path> [--root <path>] [--include-tests] [--fail-on-warn]

Examples:
  node scripts/boundary-audit.mjs callers --symbol syncSkillsToWorkspace --root src
  node scripts/boundary-audit.mjs contracts --config references/contract-template.json --root src
`);
}

function collapseWhitespace(text) {
  return text.replaceAll(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    command: null,
    flags: new Map(),
    bools: new Set(),
  };
  if (argv.length === 0) {
    return args;
  }
  args.command = argv[0];
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.bools.add(key);
      index += 1;
      continue;
    }
    args.flags.set(key, next);
    index += 2;
  }
  return args;
}

function requireFlag(parsed, key) {
  const value = parsed.flags.get(key);
  if (!value) {
    throw new Error(`Missing required flag --${key}`);
  }
  return value;
}

function getFlag(parsed, key, fallback) {
  return parsed.flags.get(key) ?? fallback;
}

function getBool(parsed, key) {
  return parsed.bools.has(key);
}

function scriptKindForFile(filePath) {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isTestLikeFile(filePath) {
  return (
    /\.test\.[cm]?[jt]sx?$/i.test(filePath) ||
    /\.spec\.[cm]?[jt]sx?$/i.test(filePath) ||
    /\.test-harness\.ts$/i.test(filePath) ||
    /\.e2e-harness\.ts$/i.test(filePath)
  );
}

async function collectSourceFiles(rootPath, options) {
  const includeTests = options.includeTests ?? false;
  const out = [];
  const root = path.resolve(rootPath);
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let stat;
    try {
      stat = await fs.stat(current);
    } catch {
      continue;
    }

    if (stat.isFile()) {
      const ext = path.extname(current).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(ext)) {
        continue;
      }
      if (!includeTests && isTestLikeFile(current)) {
        continue;
      }
      out.push(current);
      continue;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && DEFAULT_IGNORED_DIRS.has(entry.name)) {
        continue;
      }
      stack.push(path.join(current, entry.name));
    }
  }
  return out;
}

function parseSourceFile(filePath, content) {
  return ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(filePath),
  );
}

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return node;
}

function callCalleeName(call) {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return callee.name.text;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    callee.argumentExpression &&
    ts.isStringLiteral(callee.argumentExpression)
  ) {
    return callee.argumentExpression.text;
  }
  return null;
}

function callLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function traverse(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => traverse(child, visit));
}

function toRelativePath(filePath, rootDir) {
  return path.relative(rootDir, filePath).replaceAll(path.sep, "/");
}

function compileRegexList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return values.map((raw) => new RegExp(String(raw)));
}

function pathAllowed(relPath, includeRegexes, excludeRegexes) {
  if (includeRegexes.length > 0 && !includeRegexes.some((re) => re.test(relPath))) {
    return false;
  }
  if (excludeRegexes.some((re) => re.test(relPath))) {
    return false;
  }
  return true;
}

async function runCallers(parsed) {
  const symbol = requireFlag(parsed, "symbol");
  const root = path.resolve(getFlag(parsed, "root", process.cwd()));
  const includeTests = getBool(parsed, "include-tests");
  const maxSnippet = Number.parseInt(getFlag(parsed, "max-snippet", "120"), 10) || 120;

  const files = await collectSourceFiles(root, { includeTests });
  const findings = [];
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    const sourceFile = parseSourceFile(filePath, content);
    traverse(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) {
        return;
      }
      const name = callCalleeName(node);
      if (name !== symbol) {
        return;
      }
      const snippet = collapseWhitespace(node.getText(sourceFile)).slice(0, maxSnippet);
      findings.push({
        file: toRelativePath(filePath, root),
        line: callLine(sourceFile, node),
        snippet,
      });
    });
  }

  findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

  if (findings.length === 0) {
    console.log(`No callsites found for symbol "${symbol}" under ${root}.`);
    return;
  }

  console.log(`Found ${findings.length} callsite(s) for "${symbol}":`);
  for (const finding of findings) {
    console.log(`- ${finding.file}:${finding.line} :: ${finding.snippet}`);
  }
}

function readObjectPropertyName(property) {
  if (!("name" in property) || !property.name) {
    return null;
  }
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return String(name.text);
  }
  return null;
}

function collectObjectLiteralFields(objectLiteral, sourceFile) {
  const explicit = new Map();
  let hasSpread = false;
  for (const property of objectLiteral.properties) {
    if (ts.isSpreadAssignment(property)) {
      hasSpread = true;
      continue;
    }
    if (ts.isPropertyAssignment(property)) {
      const key = readObjectPropertyName(property);
      if (!key) {
        continue;
      }
      explicit.set(key, collapseWhitespace(property.initializer.getText(sourceFile)));
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      const key = property.name.text;
      explicit.set(key, key);
      continue;
    }
    if (ts.isMethodDeclaration(property)) {
      const key = readObjectPropertyName(property);
      if (!key) {
        continue;
      }
      explicit.set(key, "<method>");
    }
  }
  return { explicit, hasSpread };
}

function normalizeContract(raw) {
  const id = String(raw.id ?? raw.target ?? "contract");
  const target = String(raw.target ?? "").trim();
  if (!target) {
    throw new Error(`Contract "${id}" is missing target.`);
  }
  const argumentIndex = Number.isInteger(raw.argumentIndex) ? raw.argumentIndex : 0;
  const requiredKeys = Array.isArray(raw.requiredKeys)
    ? raw.requiredKeys.map((item) => String(item))
    : [];
  const valueMustContainRaw =
    raw.valueMustContain && typeof raw.valueMustContain === "object" ? raw.valueMustContain : {};
  const valueMustContain = Object.fromEntries(
    Object.entries(valueMustContainRaw).map(([key, values]) => [
      key,
      Array.isArray(values) ? values.map((value) => String(value)) : [],
    ]),
  );
  return {
    id,
    target,
    argumentIndex,
    requiredKeys,
    valueMustContain,
    includePathRegexes: compileRegexList(raw.includePathRegex),
    excludePathRegexes: compileRegexList(raw.excludePathRegex),
    strictSpread: raw.strictSpread === true,
  };
}

async function runContracts(parsed) {
  const configPath = path.resolve(requireFlag(parsed, "config"));
  const root = path.resolve(getFlag(parsed, "root", process.cwd()));
  const includeTests = getBool(parsed, "include-tests");
  const failOnWarn = getBool(parsed, "fail-on-warn");

  const configRaw = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!configRaw || !Array.isArray(configRaw.contracts) || configRaw.contracts.length === 0) {
    throw new Error(`Contract config must contain a non-empty "contracts" array: ${configPath}`);
  }

  const contracts = configRaw.contracts.map((contract) => normalizeContract(contract));
  const files = await collectSourceFiles(root, { includeTests });
  const findings = [];

  for (const filePath of files) {
    const relPath = toRelativePath(filePath, root);
    const content = await fs.readFile(filePath, "utf8");
    const sourceFile = parseSourceFile(filePath, content);

    for (const contract of contracts) {
      if (!pathAllowed(relPath, contract.includePathRegexes, contract.excludePathRegexes)) {
        continue;
      }

      traverse(sourceFile, (node) => {
        if (!ts.isCallExpression(node)) {
          return;
        }
        const name = callCalleeName(node);
        if (name !== contract.target) {
          return;
        }

        const line = callLine(sourceFile, node);
        const arg = node.arguments[contract.argumentIndex];
        if (!arg) {
          findings.push({
            level: "ERROR",
            contract: contract.id,
            callsite: `${relPath}:${line}`,
            reason: `missing argument[${contract.argumentIndex}] for target "${contract.target}"`,
          });
          return;
        }

        const objectArg = unwrapExpression(arg);
        if (!ts.isObjectLiteralExpression(objectArg)) {
          findings.push({
            level: "ERROR",
            contract: contract.id,
            callsite: `${relPath}:${line}`,
            reason: `argument[${contract.argumentIndex}] is not an object literal`,
          });
          return;
        }

        const fields = collectObjectLiteralFields(objectArg, sourceFile);
        for (const key of contract.requiredKeys) {
          if (!fields.explicit.has(key)) {
            if (fields.hasSpread && !contract.strictSpread) {
              findings.push({
                level: "WARN",
                contract: contract.id,
                callsite: `${relPath}:${line}`,
                reason: `required key "${key}" not explicit; object spread present`,
              });
              continue;
            }
            findings.push({
              level: "ERROR",
              contract: contract.id,
              callsite: `${relPath}:${line}`,
              reason: `missing required key "${key}"`,
            });
            continue;
          }

          const expectedValues = contract.valueMustContain[key] ?? [];
          if (expectedValues.length === 0) {
            continue;
          }
          const value = fields.explicit.get(key) ?? "";
          const matched = expectedValues.some((needle) => value.includes(needle));
          if (!matched) {
            findings.push({
              level: "ERROR",
              contract: contract.id,
              callsite: `${relPath}:${line}`,
              reason: `key "${key}" value "${value}" does not match expected tokens: ${expectedValues.join(", ")}`,
            });
          }
        }
      });
    }
  }

  if (findings.length === 0) {
    console.log(`Boundary contracts passed (${contracts.length} contract(s), root: ${root}).`);
    return;
  }

  findings.sort((a, b) => {
    if (a.level !== b.level) {
      return a.level < b.level ? -1 : 1;
    }
    if (a.contract !== b.contract) {
      return a.contract < b.contract ? -1 : 1;
    }
    return a.callsite < b.callsite ? -1 : a.callsite > b.callsite ? 1 : 0;
  });

  let errors = 0;
  let warnings = 0;
  console.error("Boundary contract findings:");
  for (const finding of findings) {
    if (finding.level === "ERROR") {
      errors += 1;
    } else if (finding.level === "WARN") {
      warnings += 1;
    }
    console.error(
      `- [${finding.level}] ${finding.contract} @ ${finding.callsite} :: ${finding.reason}`,
    );
  }
  console.error(`Summary: ${errors} error(s), ${warnings} warning(s).`);

  if (errors > 0 || (failOnWarn && warnings > 0)) {
    process.exit(1);
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === "--help" || parsed.command === "help") {
    usage();
    return;
  }
  if (parsed.command === "callers") {
    await runCallers(parsed);
    return;
  }
  if (parsed.command === "contracts") {
    await runContracts(parsed);
    return;
  }
  throw new Error(`Unknown command: ${parsed.command}`);
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
