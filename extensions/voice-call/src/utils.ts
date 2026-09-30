import os from "node:os";
import path from "node:path";

/** Runtime uses the OS home; Doctor supplies the home from its migration environment. */
export function resolveUserPath(input: string, homedir: () => string = os.homedir): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, homedir);
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
