import * as ts from "typescript/unstable/ast";

/** The stable config entrypoint is consumed by shipped updaters after replacing their own tree. */
export function buildUpdateConfigRuntimeAlias(
  targetFileName: string,
  source: ts.SourceFile,
): string {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (!ts.isNamedExports(statement.exportClause)) {
        throw new Error("Config runtime alias requires named exports");
      }
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isVariableStatement(statement)) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (
        (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
        statement.name
      ) {
        names.add(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) {
            throw new Error("Config runtime alias requires named declarations");
          }
          names.add(declaration.name.text);
        }
      }
    }
  }
  if (!names.has("createConfigIO") || !names.has("readConfigFileSnapshot")) {
    throw new Error("Config runtime lacks the published updater read contract");
  }
  const target = JSON.stringify(`./${targetFileName}`);
  const worker = String.raw`
const fs = require("node:fs");
(async () => {
  try {
    const request = JSON.parse(fs.readFileSync(0, "utf8"));
    const runtime = await import(request.target);
    const logs = [];
    const options = request.options ?? {};
    if (request.captureLogs) options.logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args })]));
    const owner = request.factory ? runtime.createConfigIO(options) : runtime;
    const value = await owner[request.operation](...request.args);
    fs.writeFileSync(3, JSON.stringify({ ok: true, value, logs }));
  } catch (error) {
    fs.writeFileSync(3, JSON.stringify({ ok: false, message: String(error) }));
    process.exitCode = 1;
  }
})().catch(() => { process.exitCode = 1; });
`;
  return `// Published updater config reads run in the candidate's dependency tree.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const target = new URL(${target}, import.meta.url).href;
const readerEntry = new URL(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const worker = ${JSON.stringify(worker)};
// Bun 1.4.2 drops the query of a dynamically imported module, so the reader is identified by an env
// marker its parent sets. A query-derived marker re-evaluates this guard as the driver and forks
// another reader, which is the unbounded chain behind #158339.
const updating = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" && process.env.OPENCLAW_CONFIG_READ_CHILD !== "1";
const runtime = updating ? undefined : await import(target);
const spawnOptions = {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    timeout: 20 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
};
function childEnv(operation, args, options) {
  const selected = options?.env ?? (operation === "readCurrentConfigForPolicyCheck" ? args[0]?.env : undefined) ?? process.env;
  return { ...selected, NODE_DISABLE_COMPILE_CACHE: "1", OPENCLAW_CONFIG_READ_CHILD: "1" };
}
function input(operation, args, options, factory) {
  // A rollback replaces the alias too; never retain the removed candidate's hashed target.
  return JSON.stringify({ target: readerEntry.href, operation, args, factory, options: options ? { ...options, logger: undefined } : undefined, captureLogs: Boolean(options?.logger) });
}
function finish(code, output, logger) {
  let result;
  try { result = JSON.parse(output || "null"); } catch {}
  for (const entry of result?.logs ?? []) logger?.[entry.level]?.(...entry.args);
  if (code === 0 && result?.ok === true) return result.value;
  const error = new Error("Candidate config read failed; the existing service definition was left unchanged. Retry with the updated CLI.");
  error.code = "candidate-config-read-failed";
  console.error("[update:warning:" + error.code + "] " + error.message);
  throw error;
}
function readSync(operation, args = [], options, factory = false) {
  const child = spawnSync(process.execPath, ["--eval", worker], {
    ...spawnOptions,
    env: childEnv(operation, args, options),
    input: input(operation, args, options, factory),
  });
  return finish(child.status, child.output?.[3], options?.logger);
}
async function read(operation, args = [], options, factory = false) {
  const request = input(operation, args, options, factory);
  const child = spawn(process.execPath, ["--eval", worker], { ...spawnOptions, env: childEnv(operation, args, options) });
  let output = "";
  let outputBytes = 0;
  child.stdio[3].setEncoding("utf8");
  child.stdio[3].on("data", chunk => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > spawnOptions.maxBuffer) child.kill("SIGKILL");
    else output += chunk;
  });
  child.stdout.resume();
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(request);
  let failed = false;
  const code = await new Promise(resolve => {
    child.once("error", () => { failed = true; });
    child.once("close", resolve);
  });
  return finish(failed || outputBytes > spawnOptions.maxBuffer ? null : code, output, options?.logger);
}
const readers = {
  createConfigIO: (options) => ({
    readBestEffortConfig: (...args) => read("readBestEffortConfig", args, options, true),
    readConfigFileSnapshot: (...args) => read("readConfigFileSnapshot", args, options, true),
    loadConfig: (...args) => readSync("loadConfig", args, options, true),
  }),
  readConfigFileSnapshot: (...args) => read("readConfigFileSnapshot", args),
  readCurrentConfigForPolicyCheck: (...args) => readSync("readCurrentConfigForPolicyCheck", args),
};
function select(name) {
  if (!updating) return runtime[name];
  if (readers[name]) return readers[name];
  return () => { throw new Error("Run config operation " + name + " in the updated CLI after this update finishes."); };
}
${[...names]
  .toSorted()
  .map(
    (name, index) =>
      `const binding${index} = select(${JSON.stringify(name)}); export { binding${index} as ${name} };`,
  )
  .join("\n")}
`;
}
