import fs from "node:fs";
import { dirname } from "node:path";

export function writeTextFileIfChanged(filePath, contents) {
  const next = String(contents);
  try {
    const current = fs.readFileSync(filePath, "utf8");
    if (current === next) {
      return false;
    }
  } catch {
    // Write the file when it does not exist or cannot be read.
  }
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

export function removeFileIfExists(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}
