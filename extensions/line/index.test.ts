import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../test/helpers/extensions/jiti-runtime-api.ts";

function normalizeModuleSpecifier(specifier: string): string | null {
  if (specifier.startsWith("./src/")) {
    return specifier;
  }
  if (specifier.startsWith("../../extensions/line/src/")) {
    return `./src/${specifier.slice("../../extensions/line/src/".length)}`;
  }
  return null;
}

function collectModuleExportNames(filePath: string): string[] {
  const sourcePath = filePath.replace(/\.js$/, ".ts");
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          names.add(element.name.text);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) {
        names.add(statement.name.text);
      }
    }
  }

  return Array.from(names).toSorted();
}

function collectRuntimeApiOverlapExports(params: {
  lineRuntimePath: string;
  runtimeApiPath: string;
}): string[] {
  const runtimeApiSource = readFileSync(params.runtimeApiPath, "utf8");
  const runtimeApiFile = ts.createSourceFile(
    params.runtimeApiPath,
    runtimeApiSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const runtimeApiLocalModules = new Set<string>();
  let pluginSdkLineRuntimeSeen = false;

  for (const statement of runtimeApiFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      pluginSdkLineRuntimeSeen = true;
      continue;
    }
    if (!pluginSdkLineRuntimeSeen) {
      continue;
    }
    const normalized = normalizeModuleSpecifier(moduleSpecifier);
    if (normalized) {
      runtimeApiLocalModules.add(normalized);
    }
  }

  const lineRuntimeSource = readFileSync(params.lineRuntimePath, "utf8");
  const lineRuntimeFile = ts.createSourceFile(
    params.lineRuntimePath,
    lineRuntimeSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const overlapExports = new Set<string>();

  for (const statement of lineRuntimeFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    const normalized = moduleSpecifier ? normalizeModuleSpecifier(moduleSpecifier) : null;
    if (!normalized || !runtimeApiLocalModules.has(normalized)) {
      continue;
    }

    if (!statement.exportClause) {
      for (const name of collectModuleExportNames(
        path.join(process.cwd(), "extensions", "line", normalized),
      )) {
        overlapExports.add(name);
      }
      continue;
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        overlapExports.add(element.name.text);
      }
    }
  }

  return Array.from(overlapExports).toSorted();
}

function collectRuntimeApiPreExports(runtimeApiPath: string): string[] {
  const runtimeApiSource = readFileSync(runtimeApiPath, "utf8");
  const runtimeApiFile = ts.createSourceFile(
    runtimeApiPath,
    runtimeApiSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const preExports = new Set<string>();

  for (const statement of runtimeApiFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      break;
    }
    const normalized = normalizeModuleSpecifier(moduleSpecifier);
    if (!normalized || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        preExports.add(element.name.text);
      }
    }
  }

  return Array.from(preExports).toSorted();
}

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");

    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: [
          "buildTemplateMessageFromPayload",
          "downloadLineMedia",
          "isSenderAllowed",
          "probeLineBot",
          "pushMessageLine",
        ],
      }),
    ).toEqual({
      buildTemplateMessageFromPayload: "function",
      downloadLineMedia: "function",
      isSenderAllowed: "function",
      probeLineBot: "function",
      pushMessageLine: "function",
    });
  }, 240_000);

  it("keeps the LINE pre-export block aligned with plugin-sdk/line-runtime overlap", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");
    const lineRuntimePath = path.join(process.cwd(), "src", "plugin-sdk", "line-runtime.ts");

    expect(collectRuntimeApiPreExports(runtimeApiPath)).toEqual(
      collectRuntimeApiOverlapExports({
        lineRuntimePath,
        runtimeApiPath,
      }),
    );
  });
});
