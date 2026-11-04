// Only the maintained final-runtime COPY declaration syntax is supported here;
// Docker remains the stage/graph owner. The installed adapter supplies two files
// from its pinned tooling context and creates the omitted package qa directory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectPackageDistImportErrors,
  collectPackageDistImports,
} from "./package-dist-imports.mjs";

export async function verifyInstalledRuntimeImageInputs({
  appRoot,
  nativeToolRoot,
  runtimeCommit,
  sourceLockSha256,
  availableFiles,
}) {
  const lock = await fs.readFile(path.join(nativeToolRoot, "pnpm-lock.yaml"));
  const entrypoint = await fs.readFile(path.join(nativeToolRoot, "docker-entrypoint.mjs"));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (sha256(lock) !== sourceLockSha256) {
    throw new Error("Native image source lock identity mismatch");
  }
  const original = execFileSync("git", ["show", `${runtimeCommit}:docker-entrypoint.mjs`], {
    cwd: nativeToolRoot,
  });
  if (!entrypoint.equals(original)) {
    throw new Error("Native image entrypoint differs from original runtime commit");
  }
  const sourceInputs = new Set(["pnpm-lock.yaml", "docker-entrypoint.mjs"]);
  const prefix = "COPY --from=selected-runtime-assets --chown=node:node ";
  const declarations = (await fs.readFile(path.join(nativeToolRoot, "Dockerfile"), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("COPY --from=selected-runtime-assets "));
  if (!declarations.length) {
    throw new Error("Missing maintained final-runtime COPY declarations");
  }
  for (const line of declarations) {
    if (!line.startsWith(prefix)) {
      throw new Error("Unsupported final-runtime COPY declaration");
    }
    for (const source of line.slice(prefix.length).split(/\s+/u).slice(0, -1)) {
      const relative = source.replace("${OPENCLAW_BUNDLED_PLUGIN_DIR}", "extensions").slice(5);
      if (
        !source.startsWith("/app/") ||
        relative.includes("$") ||
        relative.split("/").includes("..") ||
        !relative ||
        source.includes("\\")
      ) {
        throw new Error("Unsupported final-runtime COPY input");
      }
      if (sourceInputs.has(relative) || relative === "qa") {
        continue;
      }
      try {
        await fs.access(path.join(appRoot, relative));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        throw new Error(`Missing installed image input: ${relative}`, { cause: error });
      }
    }
  }
  // Scan only root importers, but resolve edges against the already validated
  // complete inventory: root modules legitimately import dist/ and scripts/.
  const files = availableFiles.includes("docker-entrypoint.mjs")
    ? availableFiles
    : [...availableFiles, "docker-entrypoint.mjs"];
  const readText = (relative) =>
    relative === "docker-entrypoint.mjs"
      ? entrypoint.toString("utf8")
      : readFileSync(path.join(appRoot, relative), "utf8");
  const imports = collectPackageDistImports({
    files: files.filter((name) => path.posix.dirname(name) === "." && name.endsWith(".mjs")),
    readText,
  });
  const errors = collectPackageDistImportErrors({ files, imports, readText });
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  return [
    { path: "pnpm-lock.yaml", sha256: sha256(lock) },
    { path: "docker-entrypoint.mjs", sha256: sha256(entrypoint) },
  ];
}
