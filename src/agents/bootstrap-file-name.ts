import path from "node:path";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export const AGENTS_BOOTSTRAP_FILENAME = "AGENTS.md";

export function normalizeBootstrapFileName(name: unknown, filePath?: unknown): string {
  const normalizedName = normalizeOptionalString(name);
  if (normalizedName) {
    return normalizedName;
  }
  const normalizedPath = normalizeOptionalString(filePath);
  if (normalizedPath) {
    const baseName = path.basename(normalizedPath.replace(/\\/g, "/"));
    if (baseName) {
      return baseName;
    }
  }
  return "bootstrap file";
}

export function isAgentsBootstrapName(name: unknown): boolean {
  return normalizeBootstrapFileName(name).toLowerCase() === AGENTS_BOOTSTRAP_FILENAME.toLowerCase();
}
