import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function readDatabase(filename, read) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

export function inspectCronBackups(databasePath) {
  const directory = path.dirname(databasePath);
  const prefix = `${path.basename(databasePath)}.doctor-cron-`;
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .toSorted()
    .map((name) => ({
      name,
      sha256: createHash("sha256")
        .update(fs.readFileSync(path.join(directory, name)))
        .digest("hex"),
    }));
}

export function findInstalledPackageRoot(startDirectory, maxDepth) {
  let directory = startDirectory;
  for (let depth = 0; depth < maxDepth; depth++, directory = path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    if (
      fs.existsSync(manifest) &&
      JSON.parse(fs.readFileSync(manifest, "utf8")).name === "openclaw"
    ) {
      return directory;
    }
  }
  return undefined;
}

export function recordProcessExitSnapshot(file, receipt, after) {
  const write = (value) =>
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  write(receipt);
  process.once("exit", (exitCode) => {
    try {
      receipt.after = after();
    } catch (error) {
      receipt.observationError = String(error);
    }
    write({ ...receipt, exitCode });
  });
}
