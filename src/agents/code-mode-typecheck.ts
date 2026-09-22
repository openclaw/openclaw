/** Optional, worker-owned compiler program. No guest module or filesystem resolution. */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { truncateUtf8Prefix } from "../utils/utf8-truncate.js";
import { ToolInputError } from "./tool-input-error.js";

const MAX_DIAGNOSTICS = 5;
const MAX_DIAGNOSTIC_BYTES = 1024;

type LibraryFile = { text: string; references: string[] };
// Each warm compiler worker keeps only pinned standard-library text and its
// import graph. Programs, ASTs, guest declarations, and diagnostics remain per-cell.
const librariesByCompiler = new WeakMap<
  typeof import("typescript"),
  Map<string, Promise<LibraryFile>>
>();

export async function checkCodeModeTypes(
  ts: typeof import("typescript"),
  code: string,
  options: { declarations: string; maxBytes: number },
): Promise<void> {
  const files = new Map<string, string>();
  let bytes = 0;
  const add = (name: string, text: string) => {
    bytes += Buffer.byteLength(text, "utf8");
    // Reuse the existing allowance, not an additional configurable memory budget.
    if (bytes > options.maxBytes) {
      throw new ToolInputError(
        "TypeScript preflight input exceeds the existing memory allowance; narrow the program or catalog.",
      );
    }
    files.set(name, text);
  };
  add("user.ts", "async function __openclawPreflight() {\n" + code + "\n}");
  add("guest.d.ts", options.declarations);
  let libraries = librariesByCompiler.get(ts);
  if (!libraries) {
    libraries = new Map();
    librariesByCompiler.set(ts, libraries);
  }
  const libDir = dirname(createRequire(import.meta.url).resolve("typescript"));
  const loadLib = async (name: string): Promise<void> => {
    if (files.has(name)) {
      return;
    }
    if (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(name)) {
      throw new ToolInputError("Invalid preflight standard library.");
    }
    let library = libraries.get(name);
    if (!library) {
      library = readFile(join(libDir, name), "utf8").then((text) => ({
        text,
        references: ts
          .preProcessFile(text)
          .libReferenceDirectives.map((ref) => "lib." + ref.fileName + ".d.ts"),
      }));
      libraries.set(name, library);
      void library.catch(() => libraries.delete(name));
    }
    const { text, references } = await library;
    // Warm libraries still consume this cell's full compiler-input allowance.
    add(name, text);
    for (const reference of references) {
      await loadLib(reference);
    }
  };
  await loadLib("lib.es2022.d.ts");
  const host: import("typescript").CompilerHost = {
    getSourceFile: (name, target) => {
      const text = files.get(name);
      return text === undefined ? undefined : ts.createSourceFile(name, text, target, true);
    },
    getDefaultLibFileName: () => "lib.es2022.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram(
    [...files.keys()],
    {
      strict: true,
      noEmit: true,
      noLib: true,
      noResolve: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
    host,
  );
  const failures = ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (failures.length === 0) {
    return;
  }
  const messages = failures.slice(0, MAX_DIAGNOSTICS).map((failure) => {
    const point =
      failure.file && failure.start !== undefined
        ? failure.file.getLineAndCharacterOfPosition(failure.start)
        : undefined;
    const location =
      failure.file?.fileName === "user.ts" && point
        ? "openclaw-code-mode:user.ts:" +
          Math.max(1, point.line) +
          ":" +
          (point.character + 1) +
          ": "
        : "";
    const message = location + ts.flattenDiagnosticMessageText(failure.messageText, "\n");
    const prefix = truncateUtf8Prefix(message, MAX_DIAGNOSTIC_BYTES);
    return prefix === message ? message : prefix + " [diagnostic truncated]";
  });
  if (failures.length > messages.length) {
    messages.push(`${failures.length - messages.length} additional errors omitted.`);
  }
  throw new ToolInputError("TypeScript preflight failed: " + messages.join("\n"));
}
