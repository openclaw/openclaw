import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPluginCommandWithTimeout, type RuntimeEnv } from "openclaw/plugin-sdk";

const MATRIX_SDK_PACKAGE = "@vector-im/matrix-bot-sdk";
const MATRIX_CRYPTO_DOWNLOAD_HELPER = "@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js";

function formatCommandError(result: { stderr: string; stdout: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) {
    return stderr;
  }
  const stdout = result.stdout.trim();
  if (stdout) {
    return stdout;
  }
  return "unknown error";
}

function isMissingMatrixCryptoRuntimeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    message.includes("Cannot find module") &&
    message.includes("@matrix-org/matrix-sdk-crypto-nodejs-")
  );
}

export function isMatrixSdkAvailable(): boolean {
  try {
    const req = createRequire(import.meta.url);
    req.resolve(MATRIX_SDK_PACKAGE);
    return true;
  } catch {
    return false;
  }
}

function resolvePluginRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..");
}

export async function ensureMatrixCryptoRuntime(
  params: {
    log?: (message: string) => void;
    requireFn?: (id: string) => unknown;
    resolveFn?: (id: string) => string;
    runCommand?: typeof runPluginCommandWithTimeout;
    nodeExecutable?: string;
  } = {},
): Promise<void> {
  const req = createRequire(import.meta.url);
  const requireFn = params.requireFn ?? ((id: string) => req(id));
  const resolveFn = params.resolveFn ?? ((id: string) => req.resolve(id));
  const runCommand = params.runCommand ?? runPluginCommandWithTimeout;
  const nodeExecutable = params.nodeExecutable ?? process.execPath;

  try {
    requireFn(MATRIX_SDK_PACKAGE);
    return;
  } catch (err) {
    if (!isMissingMatrixCryptoRuntimeError(err)) {
      throw err;
    }
  }

  const scriptPath = resolveFn(MATRIX_CRYPTO_DOWNLOAD_HELPER);
  params.log?.("matrix: crypto runtime missing; downloading platform library…");
  const result = await runCommand({
    argv: [nodeExecutable, scriptPath],
    cwd: path.dirname(scriptPath),
    timeoutMs: 300_000,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (result.code !== 0) {
    throw new Error(`Matrix crypto runtime bootstrap failed: ${formatCommandError(result)}`);
  }

  try {
    requireFn(MATRIX_SDK_PACKAGE);
  } catch (err) {
    throw new Error(
      `Matrix crypto runtime remains unavailable after bootstrap: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function ensureMatrixSdkInstalled(params: {
  runtime: RuntimeEnv;
  confirm?: (message: string) => Promise<boolean>;
}): Promise<void> {
  if (isMatrixSdkAvailable()) {
    return;
  }
  const confirm = params.confirm;
  if (confirm) {
    const ok = await confirm("Matrix requires @vector-im/matrix-bot-sdk. Install now?");
    if (!ok) {
      throw new Error("Matrix requires @vector-im/matrix-bot-sdk (install dependencies first).");
    }
  }

  const root = resolvePluginRoot();
  const command = fs.existsSync(path.join(root, "pnpm-lock.yaml"))
    ? ["pnpm", "install"]
    : ["npm", "install", "--omit=dev", "--silent"];
  params.runtime.log?.(`matrix: installing dependencies via ${command[0]} (${root})…`);
  const result = await runPluginCommandWithTimeout({
    argv: command,
    cwd: root,
    timeoutMs: 300_000,
    env: { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
  });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Matrix dependency install failed.",
    );
  }
  if (!isMatrixSdkAvailable()) {
    throw new Error(
      "Matrix dependency install completed but @vector-im/matrix-bot-sdk is still missing.",
    );
  }
}
