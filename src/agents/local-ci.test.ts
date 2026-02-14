import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect } from "vitest";

const AGENTS_DIR = join(__dirname);

describe("local-ci meta checks", () => {
  const files = readdirSync(AGENTS_DIR);

  it("all ollama-*.ts files have corresponding .test.ts files", () => {
    const ollamaFiles = files.filter(
      (f) => f.startsWith("ollama-") && f.endsWith(".ts") && !f.includes(".test."),
    );
    const missing: string[] = [];
    for (const f of ollamaFiles) {
      const testFile = f.replace(".ts", ".test.ts");
      if (!files.includes(testFile)) {
        missing.push(f);
      }
    }
    expect(missing, `Missing test files for: ${missing.join(", ")}`).toEqual([]);
  });

  it("no test files have .only or .skip left in", () => {
    const testFiles = files.filter((f) => f.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const f of testFiles) {
      const content = readFileSync(join(AGENTS_DIR, f), "utf-8");
      if (/\b(it|describe|test)\.only\b/.test(content)) {
        violations.push(`${f} has .only`);
      }
      if (/\b(it|describe|test)\.skip\b/.test(content)) {
        violations.push(`${f} has .skip`);
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("no test files import directly from node_modules", () => {
    const testFiles = files.filter((f) => f.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const f of testFiles) {
      const content = readFileSync(join(AGENTS_DIR, f), "utf-8");
      // Flag imports from node_modules paths (not bare specifiers like "vitest")
      if (/from\s+['"]\.\.\/\.\.\/node_modules\//.test(content)) {
        violations.push(f);
      }
    }
    expect(violations, `Files importing from node_modules: ${violations.join(", ")}`).toEqual([]);
  });
});
