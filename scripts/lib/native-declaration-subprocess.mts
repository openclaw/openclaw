import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";
import { emitNativeDeclarations, type NativeDeclaration } from "./native-declaration-emitter.mts";
import { isRecord } from "./record-shared.mjs";

type DeclarationRequest = Pick<
  Parameters<typeof emitNativeDeclarations>[0],
  "cwd" | "configFile" | "roots" | "compilerOptions" | "diagnostics"
>;

function readRequest(file: string): DeclarationRequest {
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    !isRecord(value) ||
    typeof value.cwd !== "string" ||
    typeof value.configFile !== "string" ||
    !Array.isArray(value.roots) ||
    !value.roots.every((root): root is string => typeof root === "string") ||
    (value.compilerOptions !== undefined && !isRecord(value.compilerOptions)) ||
    (value.diagnostics !== undefined &&
      value.diagnostics !== "declarations" &&
      value.diagnostics !== "all")
  ) {
    throw new Error("Invalid native declaration subprocess request");
  }
  return {
    cwd: value.cwd,
    configFile: value.configFile,
    roots: value.roots,
    compilerOptions: value.compilerOptions,
    diagnostics: value.diagnostics,
  };
}

function isDeclaration(value: unknown): value is NativeDeclaration {
  if (!isRecord(value) || typeof value.code !== "string" || !isRecord(value.map)) {
    return false;
  }
  const map = value.map;
  return (
    map.version === 3 &&
    typeof map.file === "string" &&
    typeof map.mappings === "string" &&
    Array.isArray(map.sources) &&
    map.sources.every((source) => typeof source === "string") &&
    Array.isArray(map.names) &&
    map.names.every((name) => typeof name === "string")
  );
}

function readResult(file: string): Awaited<ReturnType<typeof emitNativeDeclarations>> {
  const value: unknown = deserialize(fs.readFileSync(file));
  if (
    !isRecord(value) ||
    !Array.isArray(value.inputs) ||
    !value.inputs.every((input): input is string => typeof input === "string") ||
    !(value.declarations instanceof Map)
  ) {
    throw new Error("Invalid native declaration subprocess result");
  }
  const declarations = new Map<string, NativeDeclaration>();
  for (const [source, declaration] of value.declarations) {
    if (typeof source !== "string" || !isDeclaration(declaration)) {
      throw new Error("Invalid native declaration subprocess output");
    }
    declarations.set(source, declaration);
  }
  return { inputs: value.inputs, declarations };
}

/** Join native emission before synchronous semantic work can prevent its shutdown. */
export async function emitNativeDeclarationsInSubprocess(options: DeclarationRequest) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-declarations-"));
  const request = path.join(directory, "request.json");
  let joined = true;
  try {
    fs.writeFileSync(request, JSON.stringify(options));
    const worker = resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "native-declaration-subprocess",
      distWorkerPath: "legacy-finalizer/scripts/lib/native-declaration-subprocess.js",
    });
    const heapArgs = process.execArgv.flatMap((arg, index, args) =>
      /^--max[-_]old[-_]space[-_]size=/.test(arg)
        ? [arg]
        : /^--max[-_]old[-_]space[-_]size$/.test(arg)
          ? [arg, args[index + 1]!]
          : [],
    );
    let errorOutput = "";
    const code = await runManagedCommand({
      bin: process.execPath,
      args: [...heapArgs, ...resolveRuntimeWorkerArgv(worker), request],
      cwd: options.cwd,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      requireProcessTreeExit: process.platform !== "win32",
      onReady(child) {
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (chunk: string) => {
          errorOutput += chunk.slice(0, Math.max(0, 64 * 1024 - errorOutput.length));
        });
      },
    });
    if (code !== 0) {
      throw new Error(
        errorOutput.trim() || `Native declaration subprocess exited with code ${code}`,
      );
    }
    return readResult(path.join(directory, "result.bin"));
  } catch (error) {
    joined = !hasUnjoinedWork(error);
    throw error;
  } finally {
    if (joined) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const request = process.argv[2];
  if (!request || process.argv.length !== 3) {
    throw new Error("Expected one native declaration request path");
  }
  try {
    const result = await emitNativeDeclarations(readRequest(request));
    fs.writeFileSync(path.join(path.dirname(request), "result.bin"), serialize(result));
  } catch (error) {
    // API.close() only ends the compiler's stdin. An uncaught failure would exit
    // before that shutdown completes; draining the event loop joins the compiler.
    console.error(error);
    process.exitCode = 1;
  }
}
