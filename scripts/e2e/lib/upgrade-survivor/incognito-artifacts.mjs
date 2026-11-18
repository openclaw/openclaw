import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { readDatabase } from "./observations.mjs";

// Inspect synthetic cell artifacts independently of candidate backup/export filters.
export function assertNoIncognitoArtifacts(roots, marker) {
  assert(marker.length > 0);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "incognito-artifact-inspection-"));
  const seen = new Set();
  let files = 0;
  let archives = 0;
  let databases = 0;
  function checkName(name) {
    assert(!/incognito-openclaw-agent\.sqlite/u.test(name), `Incognito database artifact: ${name}`);
  }
  function decode(bytes, name) {
    assert(!bytes.includes(Buffer.from(marker)), `Incognito content persisted: ${name}`);
    if (bytes.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) {
      return decode(zlib.gunzipSync(bytes), name);
    }
    if (bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
      return decode(zlib.zstdDecompressSync(bytes), name);
    }
    return bytes;
  }
  function visit(file, name = file) {
    checkName(name);
    const physical = fs.realpathSync(file);
    if (seen.has(physical)) {
      return;
    }
    seen.add(physical);
    checkName(physical);
    if (fs.statSync(physical).isDirectory()) {
      for (const child of fs.readdirSync(physical)) {
        visit(path.join(physical, child), path.join(name, child));
      }
      return;
    }
    files++;
    const original = fs.readFileSync(physical);
    const bytes = decode(original, name);
    if (bytes.subarray(257, 262).toString() === "ustar") {
      const directory = fs.mkdtempSync(path.join(scratch, "archive-"));
      const tarball = path.join(directory, "payload.tar");
      const extracted = path.join(directory, "entries");
      fs.writeFileSync(tarball, bytes);
      fs.mkdirSync(extracted);
      execFileSync("tar", ["-xf", tarball, "-C", extracted], { timeout: 30_000 });
      archives++;
      visit(extracted, `${name}!`);
    } else if (bytes.subarray(0, 16).toString() === "SQLite format 3\0") {
      const databasePath = bytes === original ? physical : path.join(scratch, `db-${databases}`);
      if (bytes !== original) {
        fs.writeFileSync(databasePath, bytes);
      }
      readDatabase(databasePath, (db) => {
        databases++;
        for (const { name: table } of db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()) {
          assert(typeof table === "string", "SQLite table name must be text");
          const statement = db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`);
          statement.setReadBigInts(true);
          for (const row of statement.iterate()) {
            for (const value of Object.values(row)) {
              if (typeof value === "string" || value instanceof Uint8Array) {
                decode(Buffer.from(value), `${name}:${table}`);
              }
            }
          }
        }
      });
    }
  }
  try {
    for (const root of roots) {
      visit(root);
    }
    assert(files > 0, "Artifact inspection found no files");
    return { roots, files, archives, databases };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
