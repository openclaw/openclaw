import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listDirectoryTreeStrictSync } from "../src/infra/directory-walk.ts";

// Match napi's local artifact for this host, not a binary copied from another platform.
function nativeBinaryName() {
  let platform = `${process.platform}-${process.arch}`;
  if (process.platform === "linux") {
    platform += process.report.getReport().header.glibcVersionRuntime ? "-gnu" : "-musl";
  } else if (process.platform === "win32") {
    platform += "-msvc";
  }
  return `iroh-node.${platform}.node`;
}

/** A local binary is current only when it is newer than every native build input. */
export function isIrohBuildCurrent(crateDir, binaryName = nativeBinaryName()) {
  const binary = path.join(crateDir, binaryName);
  if (!existsSync(binary)) {
    return false;
  }
  const builtAt = statSync(binary).mtimeMs;
  const inputs = [
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    "package.json",
    "rust-toolchain.toml",
    "src",
  ];
  // Include directories so deleting a source file also invalidates the build.
  inputs.push(
    ...listDirectoryTreeStrictSync(path.join(crateDir, "src")).map(({ relativePath }) =>
      path.join("src", relativePath),
    ),
  );
  return inputs.every((name) => statSync(path.join(crateDir, name)).mtimeMs < builtAt);
}

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
