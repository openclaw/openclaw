import fs from "node:fs";
import path from "node:path";

/** Only the runtime manifest may declare an embedded worker or child entry. */
export function discoverStandaloneWorkers({ runtimeRoot, runtimeEntrypoints }) {
  const entries = [
    ...new Set(
      Object.values(runtimeEntrypoints).map(({ distWorkerPath }) =>
        path.posix.normalize(`dist/${distWorkerPath}`),
      ),
    ),
  ].toSorted();
  const missing = entries.filter((entry) => !fs.existsSync(path.join(runtimeRoot, entry)));
  if (missing.length) {
    throw new Error(`Missing standalone worker outputs: ${missing.join(", ")}`);
  }
  return entries;
}

/** Give each declared worker an embedded bootstrap while retaining its admission path. */
export function prepareStandaloneWorkers({
  runtimeRoot,
  outputRoot,
  workerEntries,
  runtimeBootstrap,
  moduleAliases = {},
}) {
  const wrapperRoot = path.join(outputRoot, "standalone-workers");
  const entrypoints = [];
  const workerMap = {};
  for (const entry of workerEntries) {
    const wrapper = path.join(wrapperRoot, entry);
    fs.mkdirSync(path.dirname(wrapper), { recursive: true });
    fs.writeFileSync(
      wrapper,
      `import ${JSON.stringify(runtimeBootstrap)};\nawait import(${JSON.stringify(path.join(runtimeRoot, entry))});\n`,
    );
    entrypoints.push(wrapper);
    workerMap[entry] =
      `file:///$bunfs/root/standalone-workers/${entry.replace(/\.[cm]?js$/, ".js")}`;
  }

  const workerThreadsShim = path.join(outputRoot, "standalone-worker-threads.cjs");
  // CJS consumers must share this bundled factory, not require a relocated ESM chunk.
  fs.writeFileSync(
    workerThreadsShim,
    `const path = require("node:path");
const { fileURLToPath } = require("node:url");
const native = require("node:worker_threads");
const root = path.join(path.dirname(process.execPath), "runtime");
const entries = ${JSON.stringify(workerMap)};
function embeddedWorker(filename, options) {
  if (options?.eval) return filename;
  const url = filename instanceof URL ? filename : undefined;
  if (url && url.protocol !== "file:") return filename;
  const pathname = url ? fileURLToPath(url) : filename;
  if (typeof pathname !== "string" || !path.isAbsolute(pathname)) return filename;
  const relative = path.relative(root, pathname).split(path.sep).join("/");
  if (relative.startsWith("../") || relative === "..") return filename;
  const entry = entries[relative];
  if (!entry) throw new Error("Undeclared standalone worker: " + relative);
  return new URL(entry);
}
class Worker extends native.Worker {
  constructor(filename, options) {
    super(embeddedWorker(filename, options), options);
  }
}
module.exports = { ...native, Worker };
`,
  );
  function rewriteWorkerImports(filename, contents, ast) {
    if (filename === workerThreadsShim) {
      return contents;
    }
    const edits = [];
    const pending = [ast];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== "object") {
        continue;
      }
      const source =
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ImportExpression"
          ? node.source
          : node.type === "CallExpression" && node.callee?.name === "require"
            ? node.arguments[0]
            : undefined;
      if (
        source?.value === "node:worker_threads" ||
        source?.value === "worker_threads" ||
        moduleAliases[source?.value]
      ) {
        edits.push([source.start, source.end, moduleAliases[source.value] ?? workerThreadsShim]);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          pending.push(...value);
        } else if (value && typeof value === "object") {
          pending.push(value);
        }
      }
    }
    let transformed = contents;
    for (const [start, end, target] of edits.toSorted((a, b) => b[0] - a[0])) {
      transformed = transformed.slice(0, start) + JSON.stringify(target) + transformed.slice(end);
    }
    return transformed;
  }
  return { entrypoints, workerMap, workerThreadsShim, rewriteWorkerImports };
}
