import fs from "node:fs";
import { resolveUserPath } from "../utils.js";

export function readSecretFromFile(filePath: string, label: string): string {
  const resolvedPath = resolveUserPath(filePath.trim());
  if (!resolvedPath) {
    throw new Error(`${label} file path is empty.`);
  }
  let raw = "";
  try {
    raw = fs.readFileSync(resolvedPath, "utf8");
  } catch (err) {
    throw new Error(`Failed to read ${label} file at ${resolvedPath}: ${String(err)}`, {
      cause: err,
    });
  }
  const secret = raw.trim();
  if (!secret) {
    throw new Error(`${label} file at ${resolvedPath} is empty.`);
  }
  return secret;
}
