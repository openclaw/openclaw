import { spawn } from "node:child_process";
import fs from "node:fs";

function main() {
  const [directory, expected, device, inode, tar] = process.argv.slice(2);
  if (!directory || !tar) {
    process.exitCode = 1;
    return;
  }
  try {
    process.chdir(directory);
  } catch {
    process.exitCode = 1;
    return;
  }
  if (fs.realpathSync(".") !== expected) {
    process.exitCode = 78;
    return;
  }
  const bound = fs.statSync(".", { bigint: true });
  if (String(bound.dev) !== device || String(bound.ino) !== inode) {
    process.exitCode = 78;
    return;
  }
  const child = spawn(tar, ["-czf", "-", "."], { stdio: ["ignore", "inherit", "inherit"] });
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.once("close", (code) => {
    process.exitCode = failed ? 1 : (code ?? 1);
  });
}

main();
