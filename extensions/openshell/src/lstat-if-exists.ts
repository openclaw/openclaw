import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { extractErrorCode } from "openclaw/plugin-sdk/security-runtime";

/** Inspect a link itself; only ENOENT means absent, every other failure propagates. */
export async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
