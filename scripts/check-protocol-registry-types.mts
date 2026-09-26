import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isTypeAliasDeclaration } from "typescript/unstable/ast";
import {
  collectNativeTypeScriptDiagnostics,
  formatNativeTypeScriptDiagnostics,
} from "./lib/native-typescript-diagnostics.mts";
import { createNativeTypeScriptProject } from "./lib/native-typescript.mts";
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
  const configFileName = path.join(packageRoot, "tsconfig.protocol-registry-mutability.json");
  const config = JSON.stringify({
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes,
      target: "ESNext",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: false,
      types: [],
    },
    files: [fixturePath],
  });
  let fixture = `${prelude}\ntype Registry = typeof ProtocolSchemas;\n`;
  const session = createNativeTypeScriptProject({
    cwd: packageRoot,
    configFileName,
    fs: {
      fileExists(fileName) {
        const resolved = path.resolve(fileName);
        return resolved === fixturePath || resolved === configFileName ? true : undefined;
      },
      readFile(fileName) {
        const resolved = path.resolve(fileName);
        return resolved === fixturePath
          ? fixture
          : resolved === configFileName
            ? config
            : undefined;
      },
    },
  });
  try {
    const inspect = session.project.program;
    const inputErrors = collectNativeTypeScriptDiagnostics(session.project);
    if (inputErrors.length) {
      throw new Error(formatNativeTypeScriptDiagnostics(inputErrors));
    }
    const source = inspect.getSourceFile(fixturePath);
    const declaration = source?.statements.find(isTypeAliasDeclaration);
    if (!declaration) {
      throw new Error("Public ProtocolSchemas type was not resolved");
    }
    const checker = session.project.checker;
    const registry = checker.getTypeAtLocation(declaration);
    if (!registry) {
      throw new Error("Public ProtocolSchemas type was not resolved");
    }
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
      throw new Error(
        "Expected named registry properties with the eight writable ProgressCard keys",
      );
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
    // These consumer assignments are checked in a fresh snapshot and never executed or emitted.
    const proofSnapshot = session.api.updateSnapshot({ fileChanges: { changed: [fixturePath] } });
    try {
      const proof = proofSnapshot.getProject(configFileName);
      if (!proof) {
        throw new Error("Public ProtocolSchemas proof project was not resolved");
      }
      const proofSource = proof.program.getSourceFile(fixturePath);
      if (!proofSource) {
        throw new Error("Public ProtocolSchemas proof fixture was not resolved");
      }
      const observedReadonly = new Set<number>();
      const unexpected = collectNativeTypeScriptDiagnostics(proof).filter((diagnostic) => {
        if (diagnostic.fileName && path.resolve(diagnostic.fileName) === fixturePath) {
          const line = proofSource.getLineAndCharacterOfPosition(diagnostic.pos).line + 1;
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
            `${observedReadonly.size}/${expectedReadonly} readonly assignments rejected; ${unexpected.length} unexpected diagnostics` +
            (unexpected.length ? `\n${formatNativeTypeScriptDiagnostics(unexpected)}` : ""),
        );
      }
    } finally {
      proofSnapshot.dispose();
    }
  } finally {
    session.close();
  }
}
console.log("protocol registry public mutability contract passed in both optional-property modes");
