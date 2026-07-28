// Signal CLI paths must resolve identically for setup commands and the runtime daemon.
import os from "node:os";
import path from "node:path";

export function resolveSignalCliConfigPath(
  raw: string,
  homedir: () => string = os.homedir,
): string {
  const value = raw.trim();
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}
