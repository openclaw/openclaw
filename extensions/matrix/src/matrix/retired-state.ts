import fs from "node:fs/promises";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";

export function describeRetiredMatrixState(filePath: string): string {
  return `Retired pre-July Matrix state at ${filePath} was left unchanged. Install OpenClaw 2026.9.5, run "openclaw doctor --fix", and start the Matrix channel once to migrate it, then upgrade to latest. See https://docs.openclaw.ai/channels/matrix-migration.`;
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
