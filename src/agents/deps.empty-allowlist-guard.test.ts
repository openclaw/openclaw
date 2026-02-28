/**
 * Drift Guard Test: Empty Allowlist Inline Check
 *
 * This test enforces the architectural constraint that production files in
 * src/agents/ MUST NOT contain inline `allowedContractIds.length === 0` checks
 * that throw errors.
 *
 * The correct pattern is to use the centralized helper that provides consistent
 * error handling and messaging. Inline implementations can drift and create
 * inconsistent behavior across wrappers.
 *
 * This acts as a regression guard to prevent reintroducing this anti-pattern.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ESM-compatible way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AGENTS_DIR = __dirname;

/**
 * Files that are allowed to contain the `allowedContractIds.length === 0` pattern.
 * This should only include the helper file that provides the canonical implementation.
 *
 * Add files here ONLY if they are the canonical source for empty allowlist handling.
 */
const PATTERN_ALLOWLIST = new Set<string>([
  // Example: "allowlist-guard-helper.ts" - if such a helper exists
]);

/**
 * Regex pattern to detect inline empty allowlist checks.
 *
 * Matches patterns like:
 * - allowedContractIds.length === 0
 * - allowedContractIds.length===0
 * - allowedContractIds.length  ===  0
 *
 * This pattern typically precedes a throw statement that blocks execution
 * when no contracts are allowed.
 */
const EMPTY_ALLOWLIST_PATTERN = /allowedContractIds\.length\s*===\s*0/;

/**
 * Recursively collect all .ts and .js PRODUCTION files in a directory,
 * excluding test files (*.test.ts), node_modules, and test-fixtures/test-helpers.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        // Skip node_modules, test-fixtures, and test-helpers
        if (
          entry.name === "node_modules" ||
          entry.name === "test-fixtures" ||
          entry.name === "test-helpers"
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        // Include .ts and .js files, but SKIP test files
        if (/\.(ts|js|mts|mjs)$/.test(entry.name) && !entry.name.includes(".test.")) {
          files.push(fullPath);
        }
      }
    }
  }

  walk(dir);
  return files;
}

/**
 * Find occurrences of the inline empty allowlist check pattern in a file.
 */
function findInlineEmptyAllowlistChecks(
  filePath: string,
  fileName: string
): Array<{ line: number; content: string }> {
  // Skip files in the allowlist (they're allowed to contain the pattern)
  if (PATTERN_ALLOWLIST.has(fileName)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Array<{ line: number; content: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    // Skip lines that are clearly comments
    const trimmedLine = line.trim();
    if (
      trimmedLine.startsWith("//") ||
      trimmedLine.startsWith("*") ||
      trimmedLine.startsWith("/*")
    ) {
      continue;
    }

    // Check for the inline empty allowlist pattern
    if (EMPTY_ALLOWLIST_PATTERN.test(line)) {
      violations.push({ line: lineNumber, content: trimmedLine });
    }
  }

  return violations;
}

describe("Empty Allowlist Inline Check Drift Guard", () => {
  const sourceFiles = collectSourceFiles(AGENTS_DIR);

  it("should have source files to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  describe("production files must not contain inline allowedContractIds.length === 0 checks", () => {
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(AGENTS_DIR, filePath);
      const fileName = path.basename(filePath);

      it(`${relativePath} should not have inline empty allowlist check`, () => {
        const violations = findInlineEmptyAllowlistChecks(filePath, fileName);

        if (violations.length > 0) {
          const violationDetails = violations
            .map((v) => `  Line ${v.line}: ${v.content}`)
            .join("\n");

          expect.fail(
            `\n` +
              `INLINE EMPTY ALLOWLIST CHECK DETECTED in ${relativePath}\n` +
              `\n` +
              `Production code MUST NOT contain inline 'allowedContractIds.length === 0' checks.\n` +
              `\n` +
              `This pattern should use the centralized helper instead of inline implementations\n` +
              `to ensure consistent error handling and messaging across all wrappers.\n` +
              `\n` +
              `Found ${violations.length} violation(s):\n` +
              `${violationDetails}\n` +
              `\n` +
              `To fix: Use the centralized empty allowlist guard helper instead of\n` +
              `implementing this check inline.`
          );
        }

        expect(violations).toHaveLength(0);
      });
    }
  });

  describe("summary statistics", () => {
    it("should report total files scanned", () => {
      const totalFiles = sourceFiles.length;
      const tsFiles = sourceFiles.filter((f) => f.endsWith(".ts")).length;
      const jsFiles = sourceFiles.filter(
        (f) => f.endsWith(".js") || f.endsWith(".mjs")
      ).length;
      const allowlistedFiles = sourceFiles.filter((f) =>
        PATTERN_ALLOWLIST.has(path.basename(f))
      ).length;

      console.log(
        `\nEmpty allowlist drift guard scanned ${totalFiles} files ` +
          `(${tsFiles} .ts, ${jsFiles} .js/.mjs, ${allowlistedFiles} allowlisted)`
      );

      expect(totalFiles).toBeGreaterThan(0);
    });

    it("should confirm no files have inline empty allowlist checks", () => {
      const allViolations: Array<{ file: string; line: number; content: string }> = [];

      for (const filePath of sourceFiles) {
        const fileName = path.basename(filePath);
        const violations = findInlineEmptyAllowlistChecks(filePath, fileName);
        for (const v of violations) {
          allViolations.push({
            file: path.relative(AGENTS_DIR, filePath),
            ...v,
          });
        }
      }

      if (allViolations.length > 0) {
        const summary = allViolations
          .map((v) => `  ${v.file}:${v.line} - ${v.content}`)
          .join("\n");

        expect.fail(
          `\nFound ${allViolations.length} inline empty allowlist check violation(s):\n${summary}`
        );
      }

      expect(allViolations).toHaveLength(0);
    });
  });
});
