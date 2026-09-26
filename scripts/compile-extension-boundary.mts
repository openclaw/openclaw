import fs from "node:fs";
import path from "node:path";
import { portableRelativePath } from "./lib/build-artifact-cache.mts";
import { createDeclarationInputBoundary } from "./lib/local-check-runtime.mts";
import { compileNativeProject } from "./lib/native-declaration-emitter.mts";

// Private worker: its caller owns cancellation, output inventory, and cache publication.
const request: unknown = JSON.parse(process.argv[2] ?? "null");
if (
  !request ||
  typeof request !== "object" ||
  Array.isArray(request) ||
  !("configFile" in request) ||
  typeof request.configFile !== "string" ||
  !("inputReceipt" in request) ||
  typeof request.inputReceipt !== "string" ||
  !("emit" in request) ||
  typeof request.emit !== "boolean"
) {
  throw new Error("Invalid extension boundary compiler request");
}
const boundary = createDeclarationInputBoundary(process.cwd());
let compilerOptions: Record<string, unknown> | undefined;
if ("compilerOptions" in request) {
  const value = request.compilerOptions;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid extension boundary compiler options");
  }
  compilerOptions = Object.fromEntries(Object.entries(value));
}
if (compilerOptions) {
  for (const key of ["rootDir", "outDir", "declarationDir"]) {
    const value = compilerOptions[key];
    if (typeof value === "string") {
      compilerOptions[key] = boundary.assert(value);
    }
  }
}
const inputReceipt = boundary.assert(request.inputReceipt);
const outDir =
  compilerOptions && "outDir" in compilerOptions && typeof compilerOptions.outDir === "string"
    ? boundary.assert(compilerOptions.outDir)
    : undefined;
if (request.emit && !outDir) {
  throw new Error("Declaration worker requires an owned output directory");
}
fs.rmSync(inputReceipt, { force: true });
const result = await compileNativeProject({
  cwd: boundary.root,
  compilerRoot: boundary.root,
  configFile: boundary.assert(request.configFile),
  compilerOptions,
  diagnostics: "all",
  assertInput: (file) => boundary.assert(file),
  emit: request.emit,
});
const outputs = [...result.outputFiles].map(([file, output]) => {
  const target = boundary.assert(file);
  if (
    !request.emit ||
    !outDir ||
    !path.isAbsolute(file) ||
    !target.startsWith(`${outDir}${path.sep}`) ||
    !/\.d\.[cm]?ts(?:\.map)?$/u.test(target)
  ) {
    throw new Error(`Unexpected extension boundary output: ${file}`);
  }
  return { target, text: output.text };
});
const inputs = [
  ...new Set(
    result.inputs.map((file) => portableRelativePath(boundary.root, boundary.assert(file))),
  ),
].toSorted();
for (const { target, text } of outputs) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
fs.mkdirSync(path.dirname(inputReceipt), { recursive: true });
fs.writeFileSync(inputReceipt, `${JSON.stringify({ inputs })}\n`);
for (const file of [...outputs.map(({ target }) => target), inputReceipt]) {
  process.stdout.write(`TSFILE: ${file}\n`);
}
