// Grep tool bounded read tests verify the size-check contract in the real defaultGrepOperations.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGrepOperations } from "./grep.js";

describe("defaultGrepOperations.readFile", () => {
  it("rejects non-regular files (e.g. directories)", () => {
    const tmpDir = fs.mkdtempSync("grep-bound-test-dir-");
    expect(() => defaultGrepOperations.readFile(tmpDir)).toThrow("not a regular file");
    fs.rmSync(tmpDir, { force: true, recursive: true });
  });

  it("rejects files exceeding the 50 MiB cap", () => {
    const tmpDir = fs.mkdtempSync("grep-bound-test-large-");
    const largeFile = path.join(tmpDir, "large.bin");
    const fd = fs.openSync(largeFile, "w");
    fs.ftruncateSync(fd, 51 * 1024 * 1024);
    fs.closeSync(fd);

    expect(() => defaultGrepOperations.readFile(largeFile)).toThrow("file too large");

    fs.rmSync(tmpDir, { force: true, recursive: true });
  });

  it("accepts files below the 50 MiB cap and returns their content", () => {
    const tmpDir = fs.mkdtempSync("grep-bound-test-small-");
    const smallFile = path.join(tmpDir, "small.txt");
    const content = "hello world";
    fs.writeFileSync(smallFile, content, "utf8");

    const result = defaultGrepOperations.readFile(smallFile);
    expect(result).toBe(content);

    fs.rmSync(tmpDir, { force: true, recursive: true });
  });

  it("accepts files exactly at the 50 MiB cap boundary", () => {
    const tmpDir = fs.mkdtempSync("grep-bound-test-boundary-");
    const boundaryFile = path.join(tmpDir, "boundary.bin");
    const fd = fs.openSync(boundaryFile, "w");
    fs.ftruncateSync(fd, 50 * 1024 * 1024);
    fs.closeSync(fd);

    // Should succeed because the check is strict greater-than, not greater-or-equal.
    expect(() => defaultGrepOperations.readFile(boundaryFile)).not.toThrow();

    fs.rmSync(tmpDir, { force: true, recursive: true });
  });
});
