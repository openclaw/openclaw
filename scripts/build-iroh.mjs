import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isIrohBuildCurrent } from "../src/infra/iroh-native-build.ts";

if (import.meta.main) {
  const crateDir = fileURLToPath(new URL("../crates/openclaw-iroh-node/", import.meta.url));
  if (isIrohBuildCurrent(crateDir)) {
    console.log("iroh binding is current; skipping build.");
  } else {
    // Reuse the crate's pinned napi CLI. Cargo runs here so rustup reads its toolchain file.
    const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: crateDir,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error) {
      console.error(`Could not build the iroh binding: ${result.error.message}`);
    }
    process.exitCode = result.status ?? 1;
  }
}
