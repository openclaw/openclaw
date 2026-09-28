import fs from "node:fs";

export type MemoryShadowConnection = {
  fileIdentity: { device: string; inode: string };
  extensionPath?: string;
  pragmas: {
    busy_timeout: number;
    synchronous: number;
    foreign_keys: number;
    wal_autocheckpoint: number;
    journal_size_limit: number;
    checkpoint_fullfsync: number;
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
