import { createHash } from "node:crypto";
import * as ts from "typescript/unstable/ast";

function configRuntimeAliasBindings(source: ts.SourceFile): string {
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
  return [...names]
    .toSorted()
    .map(
      (name, index) =>
        `const binding${index} = select(${JSON.stringify(name)}); export { binding${index} as ${name} };\n`,
    )
    .join("");
}

export function isUpdateConfigRuntimeAlias(
  contents: string,
  targetFileName: string,
  source: ts.SourceFile,
): boolean {
  if (contents === buildUpdateConfigRuntimeAlias(targetFileName, source)) {
    return true;
  }
  const bindings = configRuntimeAliasBindings(source);
  const target = `const target = new URL(${JSON.stringify(`./${targetFileName}`)}, import.meta.url).href;`;
  if (!contents.includes(target) || !contents.endsWith(bindings)) {
    return false;
  }
  // 2026.9.5 through 2026.10.5-beta.1 shipped the older diagnostic templates. Retain only
  // those exact bodies for that upgrade window; the target and generated bindings vary.
  const body = contents
    .slice(0, -bindings.length)
    .replace(target, 'const target = new URL("./", import.meta.url).href;');
  return [
    "f1e325b58b57ccc6f958a025bcb068bdcdc773fde0c61dc7913179c1540f2607",
    "dc8d98455b7518b7eb4f4777dee6c089d2524a7e8f9dba4b5866ec551ec03931",
    "49fbd87500f7e9b14f67c786702adf8491b8c99890a76b7f42cc836dffaef6d1",
  ].includes(createHash("sha256").update(body).digest("hex"));
}

/** The stable config entrypoint is consumed by shipped updaters after replacing their own tree. */
export function buildUpdateConfigRuntimeAlias(
  targetFileName: string,
  source: ts.SourceFile,
): string {
  const bindings = configRuntimeAliasBindings(source);
  const target = JSON.stringify(`./${targetFileName}`);
  const worker = String.raw`
const fs = require("node:fs");
// Reserve stdout for the response; config diagnostics must not corrupt its frame.
globalThis.console = new (require("node:console").Console)(process.stderr, process.stderr);
process.stdout.write = process.stderr.write.bind(process.stderr);
function send(result) {
  const payload = JSON.stringify(result);
  fs.writeFileSync(1, Buffer.byteLength(payload) + "\n" + payload);
}
(async () => {
  try {
    const request = JSON.parse(fs.readFileSync(0, "utf8"));
    const runtime = await import(request.target);
    const logs = [];
    const options = request.options ?? {};
    if (request.captureLogs) options.logger = Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level, (...args) => logs.push({ level, args })]));
    const owner = request.factory ? runtime.createConfigIO(options) : runtime;
    const value = await owner[request.operation](...request.args);
    send({ ok: true, value, logs });
  } catch (error) {
    send({ ok: false, message: String(error), code: typeof error?.code === "string" ? error.code : undefined });
    process.exitCode = 1;
  }
})().catch(() => { process.exitCode = 1; });
`;
  return `// Published updater config reads run in the candidate's dependency tree.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const target = new URL(${target}, import.meta.url).href;
const root = fileURLToPath(new URL("../", import.meta.url));
const worker = ${JSON.stringify(worker)};
const updating = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1" && process.env.OPENCLAW_CONFIG_READ_CHILD !== "1";
const runtime = updating ? undefined : await import(target);
const spawnOptions = {
    cwd: root,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 20 * 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
};
function childEnv(operation, args, options) {
  if (process.env.OPENCLAW_CONFIG_READ_CHILD === "1") {
    const error = new Error("A config reader child cannot launch another reader.");
    error.code = "candidate-config-read-recursion";
    console.warn("[update:warning:" + error.code + "] " + error.message);
    throw error;
  }
  const selected = options?.env ?? (operation === "readCurrentConfigForPolicyCheck" ? args[0]?.env : undefined) ?? process.env;
  return { ...selected, NODE_DISABLE_COMPILE_CACHE: "1", OPENCLAW_CONFIG_READ_CHILD: "1" };
}
function input(operation, args, options, factory) {
  // A rollback replaces the alias too; never retain the removed candidate's hashed target.
  return JSON.stringify({ target: import.meta.url, operation, args, factory, options: options ? { ...options, logger: undefined } : undefined, captureLogs: Boolean(options?.logger) });
}
// Reader stderr may carry config diagnostics; report only the child's error and the exit facts.
function failureReason(result, exit) {
  if (result?.ok === false) {
    const message = String(result.message);
    return typeof result.code === "string" && !message.includes(result.code) ? message + " (" + result.code + ")" : message;
  }
  if (exit.tooLarge || exit.error?.code === "ENOBUFS") return "reader output exceeded " + spawnOptions.maxBuffer + " bytes";
  if (exit.timedOut || exit.error?.code === "ETIMEDOUT") return "reader timed out after " + spawnOptions.timeout + " ms";
  if (exit.error) return "reader process failed (" + (exit.error.code ?? exit.error.message) + ")";
  if (exit.signal) return "reader process was terminated by " + exit.signal;
  return "reader process exited with code " + exit.status + (result?.ok === true ? " after reporting success" : " without a result");
}
function finish(exit, output, logger) {
  let result;
  const frame = /^(\\d+)\\n([\\s\\S]*)$/.exec(output ?? "");
  try { if (frame && Number(frame[1]) === Buffer.byteLength(frame[2])) result = JSON.parse(frame[2]); } catch {}
  for (const entry of result?.logs ?? []) logger?.[entry.level]?.(...entry.args);
  if (exit.status === 0 && !exit.error && !exit.tooLarge && result?.ok === true) return result.value;
  const characters = Array.from(failureReason(result, exit).replace(/[\\s\\u0000-\\u001f\\u007f]+/g, " ").trim());
  const reason = characters.length > 500 ? characters.slice(0, 499).join("") + "…" : characters.join("");
  const error = new Error("Candidate config read failed: " + reason + ". The existing service definition was left unchanged. Retry with the updated CLI.");
  error.code = "candidate-config-read-failed";
  console.warn("[update:warning:" + error.code + "] " + error.message);
  throw error;
}
function readSync(operation, args = [], options, factory = false) {
  const child = spawnSync(process.execPath, ["--eval", worker], {
    ...spawnOptions,
    env: childEnv(operation, args, options),
    input: input(operation, args, options, factory),
  });
  return finish(child, child.stdout, options?.logger);
}
async function read(operation, args = [], options, factory = false) {
  const request = input(operation, args, options, factory);
  const started = Date.now();
  const child = spawn(process.execPath, ["--eval", worker], { ...spawnOptions, env: childEnv(operation, args, options) });
  let output = "";
  let outputBytes = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > spawnOptions.maxBuffer) child.kill("SIGKILL");
    else output += chunk;
  });
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.end(request);
  let error;
  const exit = await new Promise(resolve => {
    child.once("error", cause => { error = cause; });
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  const timedOut = exit.signal === spawnOptions.killSignal && Date.now() - started >= spawnOptions.timeout;
  return finish({ ...exit, error, timedOut, tooLarge: outputBytes > spawnOptions.maxBuffer }, output, options?.logger);
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
${bindings}`;
}
