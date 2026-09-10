import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import ts from "typescript";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const packageRoot = path.join(resolveRepoRoot(import.meta.url), "packages/gateway-protocol");
const fixturePath = path.join(packageRoot, "protocol-registry-mutability.contract.mts");
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const publicModule: unknown = await import(
  pathToFileURL(requireFromPackage.resolve("@openclaw/gateway-protocol/schema")).href
);
if (!isRecord(publicModule) || !isRecord(publicModule.ProtocolSchemas)) {
  throw new Error("Public emitted ProtocolSchemas runtime registry was not resolved");
}
const runtimeKeys = Object.keys(publicModule.ProtocolSchemas).toSorted();
const writable = new Set([
  "ProgressCardStepStatus",
  "ProgressCardStep",
  "ProgressCard",
  "ProgressCardGetParams",
  "ProgressCardGetResult",
  "ProgressCardPutParams",
  "ProgressCardPutResult",
  "ProgressCardChangedEvent",
]);
const prelude = 'import { ProtocolSchemas } from "@openclaw/gateway-protocol/schema";';

for (const exactOptionalPropertyTypes of [true, false]) {
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  };
  let fixture = `${prelude}\ntype Registry = typeof ProtocolSchemas;\n`;
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(fileName) === fixturePath
      ? ts.createSourceFile(fileName, fixture, languageVersion, true)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const inspect = ts.createProgram([fixturePath], options, host);
  const inputErrors = ts.getPreEmitDiagnostics(inspect);
  if (inputErrors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(inputErrors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => packageRoot,
        getNewLine: () => "\n",
      }),
    );
  }
  const source = inspect.getSourceFile(fixturePath);
  const declaration = source?.statements.find(ts.isTypeAliasDeclaration);
  if (!declaration) {
    throw new Error("Public ProtocolSchemas type was not resolved");
  }
  const checker = inspect.getTypeChecker();
  const registry = checker.getTypeAtLocation(declaration);
  const keys = checker
    .getPropertiesOfType(registry)
    .map((symbol) => symbol.name)
    .toSorted();
  if (JSON.stringify(keys) !== JSON.stringify(runtimeKeys)) {
    throw new Error("Public emitted registry keys differ between runtime and declarations");
  }
  if (
    !keys.length ||
    [...writable].some((key) => !keys.includes(key)) ||
    checker.getIndexInfosOfType(registry).length !== 0
  ) {
    throw new Error("Expected named registry properties with the eight writable ProgressCard keys");
  }

  const lines = [prelude];
  const readonlyLines = new Set<number>();
  const expectedReadonly = keys.length - writable.size;
  for (const key of keys) {
    lines.push(
      `ProtocolSchemas[${JSON.stringify(key)}] = ProtocolSchemas[${JSON.stringify(key)}];`,
    );
    if (!writable.has(key)) {
      readonlyLines.add(lines.length);
    }
  }
  fixture = `${lines.join("\n")}\n`;
  // These consumer assignments are compiled in memory and never executed or emitted.
  const proof = ts.createProgram([fixturePath], options, host);
  const observedReadonly = new Set<number>();
  const unexpected = ts.getPreEmitDiagnostics(proof).filter((diagnostic) => {
    if (
      diagnostic.file &&
      path.resolve(diagnostic.file.fileName) === fixturePath &&
      diagnostic.start !== undefined
    ) {
      const line = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
      if (diagnostic.code === 2540 && readonlyLines.has(line)) {
        observedReadonly.add(line);
        return false;
      }
    }
    return true;
  });
  if (unexpected.length || observedReadonly.size !== expectedReadonly) {
    throw new Error(
      `Registry mutability mismatch (exactOptionalPropertyTypes=${exactOptionalPropertyTypes}): ` +
        `${observedReadonly.size}/${expectedReadonly} readonly assignments rejected; ${unexpected.length} unexpected diagnostics`,
    );
  }
}
console.log("protocol registry public mutability contract passed in both optional-property modes");
