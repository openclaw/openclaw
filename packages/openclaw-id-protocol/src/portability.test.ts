import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Lists .ts files below `dir` without following symlinks.
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  });
}

// Shared protocol code runs in Node, browsers and Workers: WebCrypto only, no Node built-ins.
describe("portability", () => {
  it("non-test sources import neither node:* modules nor Buffer", () => {
    const sources = sourceFiles(import.meta.dirname);
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect({
        file,
        nodeImport: /from "node:|require\(/.test(text),
        buffer: /\bBuffer\./.test(text),
      }).toEqual({
        file,
        nodeImport: false,
        buffer: false,
      });
    }
  });
});
