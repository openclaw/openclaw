import type { RuntimeEnv } from "openclaw/plugin-sdk";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMatrixRuntime } from "../runtime.js";

const REQUIRED_MATRIX_PACKAGES = ["matrix-js-sdk", "@matrix-org/matrix-sdk-crypto-nodejs"];

function resolveMissingMatrixPackages(): string[] {
  try {
    const req = createRequire(import.meta.url);
    return REQUIRED_MATRIX_PACKAGES.filter((pkg) => {
      try {
        req.resolve(pkg);
        return false;
      } catch {
        return true;
      }
    });
  } catch {
    return [...REQUIRED_MATRIX_PACKAGES];
  }
}

export function isMatrixSdkAvailable(): boolean {
  return resolveMissingMatrixPackages().length === 0;
}

function resolvePluginRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "..");
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
    const ok = await confirm(
      "Matrix requires matrix-js-sdk and @matrix-org/matrix-sdk-crypto-nodejs. Install now?",
    );
    if (!ok) {
      throw new Error(
        "Matrix requires matrix-js-sdk and @matrix-org/matrix-sdk-crypto-nodejs (install dependencies first).",
      );
    }
  }

  const root = resolvePluginRoot();
  const command = fs.existsSync(path.join(root, "pnpm-lock.yaml"))
    ? ["pnpm", "install"]
    : ["npm", "install", "--omit=dev", "--silent"];
  params.runtime.log?.(`matrix: installing dependencies via ${command[0]} (${root})…`);
  const result = await getMatrixRuntime().system.runCommandWithTimeout(command, {
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
    const missing = resolveMissingMatrixPackages();
    throw new Error(
      missing.length > 0
        ? `Matrix dependency install completed but required packages are still missing: ${missing.join(", ")}`
        : "Matrix dependency install completed but Matrix dependencies are still missing.",
    );
  }
}
