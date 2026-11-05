import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { syncKnowledgeDirectory } from "./directory-sync.js";
import { PublicationFiles } from "./publication-files.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

it.each(["EIO", "ENOSPC"])("propagates unexpected directory %s errors", (code) => {
  const root = tempDirs.make("knowledge-directory-error-");
  const error = Object.assign(new Error(`Directory ${code}`), { code });
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
    throw error;
  });
  expect(() => syncKnowledgeDirectory(root)).toThrow(error);
});

it("never treats regular-file EPERM as unsupported directory flushing", () => {
  const root = tempDirs.make("knowledge-file-error-");
  const files = new PublicationFiles(root);
  const error = Object.assign(new Error("File EPERM"), { code: "EPERM" });
  vi.spyOn(fs, "fsyncSync").mockImplementation(() => {
    throw error;
  });
  syncBuiltinESMExports();
  expect(() => files.exclusive("note.md", "Not durably published")).toThrow(error);
});

it("rejects a redirected directory rather than accepting an unsupported outcome", () => {
  const root = tempDirs.make("knowledge-directory-identity-");
  const target = path.join(root, "target"),
    alias = path.join(root, "alias");
  fs.mkdirSync(target);
  fs.symlinkSync(target, alias, "junction");
  expect(() => syncKnowledgeDirectory(alias)).toThrow();
});
