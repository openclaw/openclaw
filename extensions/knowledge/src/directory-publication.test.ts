import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { PublicationFiles } from "./publication-files.js";
import { useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

it("publishes exact bytes when Windows cannot flush a verified directory", () => {
  const root = tempDirs.make("knowledge-windows-publication-");
  const files = new PublicationFiles(root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const sync = fs.fsyncSync;
  const directorySync = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    if (fs.fstatSync(fd).isDirectory()) {
      throw Object.assign(new Error("Directory flush unsupported"), { code: "EPERM" });
    }
    sync(fd);
  });
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    syncBuiltinESMExports();
    files.exclusive("note.md", "Exact persisted bytes\n");
    expect(fs.readFileSync(path.join(root, "note.md"), "utf8")).toBe("Exact persisted bytes\n");
    expect(directorySync).toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, "platform", platform);
    directorySync.mockRestore();
    syncBuiltinESMExports();
  }
});
