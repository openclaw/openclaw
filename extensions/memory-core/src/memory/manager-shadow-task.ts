import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

export type MemoryShadowConnection = {
  fileIdentity: { device: string; inode: string };
  extensionPath?: string;
  // Schema admission temporarily disables foreign keys and restores the opener's policy.
  pragmas: {
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
  const value = db.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(errorMessage);
  }
  return { foreign_keys: value };
}
