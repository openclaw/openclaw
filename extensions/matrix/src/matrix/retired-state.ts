import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";

export const RETIRED_MATRIX_STATE_FILENAMES: ReadonlySet<string> = new Set([
  "thread-bindings.json",
  "startup-verification.json",
  "recovery-key.json",
  "legacy-crypto-migration.json",
  "crypto-idb-snapshot.json",
  "storage-meta.json",
  "inbound-dedupe.json",
]);

export async function assertMatrixSupportedStateRoot(rootDir: string): Promise<void> {
  for (const filename of RETIRED_MATRIX_STATE_FILENAMES) {
    await assertMatrixSupportedStateFile(path.join(rootDir, filename));
  }
}

export const RETIRED_MATRIX_STATE_REMEDIATION =
  'Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest.';

export function describeRetiredMatrixState(filePath: string): string {
  return `Retired pre-July Matrix state at ${filePath} was left unchanged. ${RETIRED_MATRIX_STATE_REMEDIATION} See https://docs.openclaw.ai/channels/matrix-migration.`;
}

export async function assertMatrixSupportedStateFile(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(describeRetiredMatrixState(filePath));
}
