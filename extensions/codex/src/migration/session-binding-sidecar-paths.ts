import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
export async function readDirectoryEntries(directory: string) {
  try {
    return await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      isRecord(error) &&
      typeof error.code === "string" &&
      ["EACCES", "ENOENT", "ENOTDIR", "EPERM"].includes(error.code)
    ) {
      return [];
    }
    throw error;
  }
}
