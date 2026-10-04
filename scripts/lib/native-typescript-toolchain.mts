import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Native execution and its JavaScript API transport share one content identity. */
export function nativeTypeScriptToolchainFiles(
  packageJson: string,
  admit: (file: string) => string,
): string[] {
  const nativePackage = admit(packageJson);
  const require = createRequire(nativePackage);
  const nativeRoot = path.dirname(nativePackage);
  const executableResolver = admit(path.join(nativeRoot, "lib/getExePath.js"));
  // Normalize the native launcher's Windows extended-length path spelling.
  const executable: string = require(executableResolver).default();
  const platformPackage = admit(
    require.resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`),
  );
  const files = [
    nativePackage,
    platformPackage,
    fileURLToPath(pathToFileURL(executable)),
    path.join(
      path.dirname(platformPackage),
      "lib",
      process.platform === "win32" ? "tsc.exe" : "tsc",
    ),
    path.join(nativeRoot, "bin/tsc"),
    path.join(nativeRoot, "lib/tsc.js"),
    executableResolver,
    require.resolve("typescript"),
  ].map(admit);
  const visited = new Set<string>();
  const collectRuntime = (directory: string) => {
    const root = admit(directory);
    const real = fs.realpathSync.native(root);
    if (visited.has(real)) {
      return;
    }
    visited.add(real);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = admit(path.join(root, entry.name));
      const stat = entry.isSymbolicLink() ? fs.statSync(file) : entry;
      if (stat.isDirectory()) {
        collectRuntime(file);
      } else if (stat.isFile() && /\.(?:[cm]?js|json)$/u.test(entry.name)) {
        files.push(file);
      }
    }
  };
  collectRuntime(path.join(nativeRoot, "dist"));
  collectRuntime(path.join(nativeRoot, "vendor"));
  return [...new Set(files)].toSorted();
}
