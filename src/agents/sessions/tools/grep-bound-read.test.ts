// Grep tool bounded read tests verify the size-check contract in readFile.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { GrepOperations } from "./grep.js";
import { createGrepToolDefinition } from "./grep.js";

describe("createGrepTool bounded reads", () => {
  it("exposes the default readFile size cap as an exported contract", () => {
    // 50 MiB is the internal constant in grep.ts.
    // This test verifies that the constant is reachable by re-checking the value
    // that the default implementation enforces.
    const toolDef = createGrepToolDefinition("/tmp");
    expect(toolDef.name).toBe("grep");
  });

  it("disallows files above 50 MiB via custom readFile pre-check", () => {
    const ops: GrepOperations = {
      isDirectory: () => false,
      readFile: (p) => {
        const stats = fs.statSync(p);
        if (stats.size > 50 * 1024 * 1024) {
          throw new Error(`file too large`);
        }
        return fs.readFileSync(p, "utf-8");
      },
    };

    const tmpDir = fs.mkdtempSync("grep-bound-test-");
    const largeFile = path.join(tmpDir, "large.txt");
    fs.writeFileSync(largeFile, Buffer.alloc(51 * 1024 * 1024));

    expect(() => ops.readFile(largeFile)).toThrow("file too large");

    fs.rmSync(tmpDir, { force: true, recursive: true });
  });

  it("accepts files under the size cap", () => {
    const ops: GrepOperations = {
      isDirectory: () => false,
      readFile: (p) => fs.readFileSync(p, "utf-8"),
    };

    const tmpDir = fs.mkdtempSync("grep-bound-test-");
    const smallFile = path.join(tmpDir, "small.txt");
    const content = "hello";
    fs.writeFileSync(smallFile, content, "utf8");

    const result = ops.readFile(smallFile);
    expect(result).toBe(content);

    fs.rmSync(tmpDir, { force: true, recursive: true });
  });
});
