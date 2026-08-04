import os from "node:os";
import path from "node:path";

/** Keep every Signal-owned signal-cli invocation on the daemon's established path contract. */
export function resolveSignalCliConfigPath(raw: string): string {
  const value = raw.trim();
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}
