import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type MemoryShadowConnection = {
  fileIdentity: { device: string; inode: string };
  extensionPath?: string;
  // The opener owns connection policy; publication only restores temporary transaction settings.
  pragmas: {
    busy_timeout: number;
    foreign_keys: number;
  };
};

export type MemoryShadowFailure = {
  name: string;
  message: string;
  code?: string;
  errcode?: number;
};

export function readMemoryShadowIdentity(filename: string): MemoryShadowConnection["fileIdentity"] {
  const info = fs.statSync(filename, { bigint: true });
  if (!info.isFile()) {
    throw new Error("Memory reindex shadow is not a regular file");
  }
  return { device: String(info.dev), inode: String(info.ino) };
}

export function assertMemoryShadowIdentity(
  filename: string,
  expected: MemoryShadowConnection["fileIdentity"],
): void {
  const actual = readMemoryShadowIdentity(filename);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Memory reindex shadow file changed during its owned lifetime");
  }
}

export function readMemoryConnectionPragmas(db: DatabaseSync, errorMessage: string) {
  const read = (name: keyof MemoryShadowConnection["pragmas"]): number => {
    const row = db.prepare(`PRAGMA ${name}`).get();
    const value = row?.[name] ?? row?.timeout;
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(errorMessage);
    }
    return value;
  };
  return {
    busy_timeout: read("busy_timeout"),
    foreign_keys: read("foreign_keys"),
  };
}
