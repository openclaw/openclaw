import os from "node:os";
import path from "node:path";

/** Runtime uses the OS home; Doctor supplies the home from its migration environment. */
export function resolveUserPath(input: string, homedir: () => string = os.homedir): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir));
}
