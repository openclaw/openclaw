import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isSqliteWalResetSafeVersion } from "../../node-sqlite.mjs";

const LIBRARY_PATH = "lib/libsqlite3.dylib";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Standalone SQLite preparation failed: ${result.error?.message ?? result.stderr?.trim() ?? command}`,
    );
  }
  return result.stdout;
}

function probeSqlite(bunExecutable, library) {
  const output = run(bunExecutable, [
    "--eval",
    `
      const { Database } = require("bun:sqlite");
      ${library ? `Database.setCustomSQLite(${JSON.stringify(library)});` : ""}
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(":memory:");
      try {
        const { version, omitted } = database.prepare(
          "SELECT sqlite_version() AS version, sqlite_compileoption_used('OMIT_LOAD_EXTENSION') AS omitted"
        ).get();
        database.exec("CREATE VIRTUAL TABLE probe USING fts5(content)");
        database.prepare("SELECT json('{}')").get();
        const compileOptions = database.prepare("PRAGMA compile_options").all()
          .map(row => row.compile_options).sort();
        console.log(JSON.stringify({ version, extensionLoadingSupported: omitted === 0, compileOptions }));
      } finally {
        database.close();
      }
    `,
  ]);
  const probe = JSON.parse(output);
  if (!isSqliteWalResetSafeVersion(probe.version)) {
    throw new Error(`Standalone SQLite ${probe.version} is below the WAL safety floor.`);
  }
  if (!probe.extensionLoadingSupported) {
    throw new Error("Standalone SQLite was built with SQLITE_OMIT_LOAD_EXTENSION.");
  }
  return probe;
}

/** Share the macOS app's pinned SQLite build; Linux uses Bun's qualified static library. */
export function stageStandaloneSqlite({
  repoRoot,
  runtimeRoot,
  bunExecutable,
  platform = process.platform,
  arch = process.arch,
}) {
  if (platform === "linux") {
    return {
      files: [],
      manifest: { source: "bun", ...probeSqlite(bunExecutable), license: "public-domain" },
    };
  }
  if (platform !== "darwin" || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported standalone SQLite target: ${platform}-${arch}`);
  }
  const pin = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "scripts/lib/sqlite-macos.json"), "utf8"),
  );
  run("/bin/bash", [
    path.join(repoRoot, "scripts/build-mac-sqlite.sh"),
    arch === "x64" ? "x86_64" : arch,
    runtimeRoot,
  ]);
  const library = path.join(runtimeRoot, LIBRARY_PATH);
  const probe = probeSqlite(bunExecutable, library);
  if (probe.version !== pin.version) {
    throw new Error(
      `Standalone SQLite version differs from pin: ${probe.version} != ${pin.version}`,
    );
  }
  return {
    files: [{ source: LIBRARY_PATH, destination: LIBRARY_PATH, category: "nativeLibraries" }],
    manifest: {
      source: "bundled",
      path: LIBRARY_PATH,
      ...probe,
      sha256: createHash("sha256").update(fs.readFileSync(library)).digest("hex"),
      sourceArchive: { url: pin.url, sha256: pin.sha256 },
      license: "public-domain",
    },
  };
}
