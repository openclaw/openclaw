import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateSecureToken } from "../infra/secure-random.js";
import { runExec } from "../process/exec.js";

function getPathModuleForHome(homeDir: string): typeof path.posix {
  if (/^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.includes("\\")) {
    return path.win32;
  }
  return path.posix;
}

export async function movePathToTrash(targetPath: string): Promise<string> {
  try {
    await runExec("trash", [targetPath], { timeoutMs: 10_000 });
    return targetPath;
  } catch {
    const homeDir = os.homedir();
    const homePath = getPathModuleForHome(homeDir);
    const trashDir = homePath.join(homeDir, ".Trash");
    fs.mkdirSync(trashDir, { recursive: true });
    const base = homePath.basename(targetPath);
    let dest = homePath.join(trashDir, `${base}-${Date.now()}`);
    if (fs.existsSync(dest)) {
      dest = homePath.join(trashDir, `${base}-${Date.now()}-${generateSecureToken(6)}`);
    }
    fs.renameSync(targetPath, dest);
    return dest;
  }
}
