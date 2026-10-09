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
