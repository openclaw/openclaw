import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hashFile(filename, chunkBytes) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filename, "r");
  try {
    const buffer = Buffer.alloc(chunkBytes);
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

export function childOf(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function retainedSnapshots(roots) {
  const retained = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/^openclaw-(?:sqlite-readonly-|doctor-lint-state-)/.test(entry.name)) {
        retained.push(file);
      }
      if (entry.isDirectory()) {
        visit(file);
      }
    }
  };
  for (const root of new Set(roots)) {
    visit(root);
  }
  return retained.toSorted((a, b) => a.localeCompare(b));
}

export function sqliteFamily(databasePath, digest) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
      const file = `${databasePath}${suffix}`;
      return fs.existsSync(file) ? [[suffix || "main", digest(file)]] : [];
    }),
  );
}
