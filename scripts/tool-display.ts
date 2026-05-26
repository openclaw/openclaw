import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/agents/tool-display-config.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const configPath = path.join(repoRoot, "src/agents/tool-display-config.ts");
const outputPath = path.join(
  repoRoot,
  "apps/shared/OpenClawKit/Sources/OpenClawKit/Resources/tool-display.json",
);
const toolSources = [
  path.join(repoRoot, "src/agents/apply-patch.ts"),
  path.join(repoRoot, "src/agents/bash-tools.exec.ts"),
  path.join(repoRoot, "src/agents/bash-tools.process.ts"),
  path.join(repoRoot, "src/auto-reply/reply/acp-projector.ts"),
];

type DuplicateToolKey = {
  name: string;
  lines: number[];
};

export function main(argv = process.argv.slice(2)): number {
  const args = new Set(argv);
  const shouldCheck = args.has("--check");
  const shouldWrite = args.has("--write");

  if (!shouldCheck && !shouldWrite) {
    console.error("Usage: node --import tsx scripts/tool-display.ts --check|--write");
    return 1;
  }

  const duplicateErrors = collectToolDisplayDuplicateErrors({ includeSnapshot: shouldCheck });
  if (duplicateErrors.length > 0) {
    console.error(duplicateErrors.join("\n"));
    return 1;
  }

  const expected = serializeToolDisplayConfig();
  ensureCoreToolCoverage();

  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected);
    process.stdout.write(`wrote ${path.relative(repoRoot, outputPath)}\n`);
    return 0;
  }

  if (!fs.existsSync(path.dirname(outputPath))) {
    process.stdout.write(
      `skip tool-display snapshot check; missing ${path.relative(repoRoot, path.dirname(outputPath))}\n`,
    );
    return 0;
  }

  if (!fs.existsSync(outputPath)) {
    console.error(
      `missing generated snapshot: ${path.relative(repoRoot, outputPath)}\nrun: pnpm tool-display:write`,
    );
    return 1;
  }

  const actual = fs.readFileSync(outputPath, "utf8");
  if (actual !== expected) {
    console.error(
      `tool-display snapshot is stale: ${path.relative(repoRoot, outputPath)}\nrun: pnpm tool-display:write`,
    );
    return 1;
  }

  process.stdout.write("tool-display snapshot is up to date\n");
  return 0;
}

function ensureCoreToolCoverage() {
  const toolNames = new Set<string>();
  for (const sourcePath of toolSources) {
    collectToolNamesFromFile(sourcePath, toolNames);
  }
  for (const entry of fs.readdirSync(path.join(repoRoot, "src/agents/tools"))) {
    if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) {
      continue;
    }
    collectToolNamesFromFile(path.join(repoRoot, "src/agents/tools", entry), toolNames);
  }
  const missing = [...toolNames].filter((name) => !TOOL_DISPLAY_CONFIG.tools[name]).toSorted();
  if (missing.length > 0) {
    console.error(
      `tool-display metadata missing for runtime tools: ${missing.join(", ")}\nupdate: src/agents/tool-display-config.ts`,
    );
    process.exit(1);
  }
}

function collectToolNamesFromFile(sourcePath: string, names: Set<string>) {
  const source = fs.readFileSync(sourcePath, "utf8");
  for (const match of source.matchAll(/\bname:\s*"([A-Za-z0-9_-]+)"/g)) {
    const name = match[1]?.trim();
    if (name) {
      names.add(name);
    }
  }
}

function serializeToolDisplayConfig(config: ToolDisplayConfig = TOOL_DISPLAY_CONFIG): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function collectToolDisplayDuplicateErrors(options: { includeSnapshot: boolean }): string[] {
  const duplicateErrors: string[] = [];
  const configSource = fs.readFileSync(configPath, "utf8");
  const configDuplicates = collectToolDisplayConfigDuplicateKeys(configSource, configPath);
  if (configDuplicates.length > 0) {
    duplicateErrors.push(
      formatDuplicateToolKeyError(path.relative(repoRoot, configPath), configDuplicates),
    );
  }

  if (options.includeSnapshot && fs.existsSync(outputPath)) {
    const snapshotSource = fs.readFileSync(outputPath, "utf8");
    const snapshotDuplicates = collectToolDisplaySnapshotDuplicateKeys(snapshotSource, outputPath);
    if (snapshotDuplicates.length > 0) {
      duplicateErrors.push(
        formatDuplicateToolKeyError(path.relative(repoRoot, outputPath), snapshotDuplicates),
      );
    }
  }
  return duplicateErrors;
}

export function collectToolDisplayConfigDuplicateKeys(
  source: string,
  sourcePath = "src/agents/tool-display-config.ts",
): DuplicateToolKey[] {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);
  let toolsObject: ts.ObjectLiteralExpression | undefined;
  visitToolDisplayConfig(sourceFile, (configObject) => {
    toolsObject = findObjectProperty(configObject, "tools");
  });
  return toolsObject ? collectDuplicatePropertyKeys(toolsObject, sourceFile) : [];
}

export function collectToolDisplaySnapshotDuplicateKeys(
  source: string,
  sourcePath = "tool-display.json",
): DuplicateToolKey[] {
  const sourceFile = ts.parseJsonText(sourcePath, source);
  const statement = sourceFile.statements[0];
  if (!statement || !ts.isExpressionStatement(statement)) {
    return [];
  }
  const root = statement.expression;
  if (!ts.isObjectLiteralExpression(root)) {
    return [];
  }
  const toolsObject = findObjectProperty(root, "tools");
  return toolsObject ? collectDuplicatePropertyKeys(toolsObject, sourceFile) : [];
}

export function formatDuplicateToolKeyError(
  relativePath: string,
  duplicates: DuplicateToolKey[],
): string {
  const formatted = duplicates
    .map((duplicate) => `${duplicate.name} at lines ${duplicate.lines.join(", ")}`)
    .join("; ");
  return `tool-display metadata has duplicate tool ids in ${relativePath}: ${formatted}`;
}

function visitToolDisplayConfig(
  node: ts.Node,
  onConfig: (configObject: ts.ObjectLiteralExpression) => void,
) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "TOOL_DISPLAY_CONFIG" &&
    node.initializer &&
    ts.isObjectLiteralExpression(node.initializer)
  ) {
    onConfig(node.initializer);
    return;
  }
  ts.forEachChild(node, (child) => visitToolDisplayConfig(child, onConfig));
}

function findObjectProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.ObjectLiteralExpression | undefined {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      getPropertyNameText(property.name) === propertyName &&
      ts.isObjectLiteralExpression(property.initializer)
    ) {
      return property.initializer;
    }
  }
  return undefined;
}

function collectDuplicatePropertyKeys(
  object: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
): DuplicateToolKey[] {
  const keyLines = new Map<string, number[]>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = getPropertyNameText(property.name);
    if (!name) {
      continue;
    }
    const line =
      sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile)).line + 1;
    keyLines.set(name, [...(keyLines.get(name) ?? []), line]);
  }
  return [...keyLines.entries()]
    .filter(([, lines]) => lines.length > 1)
    .map(([name, lines]) => ({ name, lines }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

function getPropertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
