import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";

/** Inspect a link itself; only ENOENT means absent, every other failure propagates. */
export async function lstatIfExists(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}
