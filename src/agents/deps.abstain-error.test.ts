/**
 * Import Guard Test: ClarityBurstAbstainError Canonical Source
 *
 * This test enforces the architectural constraint that production files in
 * src/agents/ MUST import ClarityBurstAbstainError from the canonical source:
 *   ../clarityburst/errors.js
 *
 * NOT from the re-export in:
 *   ./bash-tools.exec.js
 *
 * The re-export in bash-tools.exec.ts exists only for backward compatibility
 * with external consumers. Internal code should always use the canonical source.
 *
 * EXCEPTION: bash-tools.exec.ts itself is allowed to re-export the error
 * (it imports from the canonical source and re-exports).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// ESM-compatible way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const AGENTS_DIR = __dirname;

// Files that are allowed to re-export ClarityBurstAbstainError from bash-tools.exec
const REEXPORT_ALLOWLIST = new Set(["bash-tools.exec.ts"]);

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
 * Pattern to detect imports of ClarityBurstAbstainError from bash-tools.exec
 * instead of from the canonical ../clarityburst/errors.js source.
 *
 * Matches patterns like:
 * - import { ClarityBurstAbstainError } from "./bash-tools.exec.js"
 * - import { ClarityBurstAbstainError, Foo } from "./bash-tools.exec"
 * - import { Foo, ClarityBurstAbstainError } from "./bash-tools.exec.ts"
 * - } from "./bash-tools.exec.js" (multi-line import)
 *
 * Does NOT match:
 * - import { ClarityBurstAbstainError } from "../clarityburst/errors.js" (canonical)
 * - export { ClarityBurstAbstainError } from "./bash-tools.exec.js" (re-export is different)
 */
function findBadAbstainErrorImports(
  filePath: string,
  fileName: string
): Array<{ line: number; content: string }> {
  // Skip files in the allowlist (they're allowed to do re-exports)
  if (REEXPORT_ALLOWLIST.has(fileName)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Array<{ line: number; content: string }> = [];

  // State for tracking multi-line imports
  let inMultiLineImport = false;
  let multiLineHasClarityBurstAbstainError = false;
  let multiLineStartLine = 0;
  let multiLineContent = "";

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

    // Check for start of multi-line import
    if (!inMultiLineImport && /^\s*import\s*\{/.test(line) && !line.includes("from")) {
      inMultiLineImport = true;
      multiLineStartLine = lineNumber;
      multiLineContent = line;
      multiLineHasClarityBurstAbstainError = /ClarityBurstAbstainError/.test(line);
      continue;
    }

    // Continue multi-line import
    if (inMultiLineImport) {
      multiLineContent += " " + line.trim();

      if (/ClarityBurstAbstainError/.test(line)) {
        multiLineHasClarityBurstAbstainError = true;
      }

      // Check for end of multi-line import with "from"
      if (/from\s+['"]/.test(line)) {
        // Multi-line import ended, check if it imports from bash-tools.exec
        if (
          multiLineHasClarityBurstAbstainError &&
          /from\s+['"]\.\/bash-tools\.exec(\.js|\.ts)?['"]/.test(line)
        ) {
          violations.push({
            line: multiLineStartLine,
            content: multiLineContent.trim(),
          });
        }

        // Reset state
        inMultiLineImport = false;
        multiLineHasClarityBurstAbstainError = false;
        multiLineStartLine = 0;
        multiLineContent = "";
      }
      continue;
    }

    // Single-line import check
    // Pattern: import { ... ClarityBurstAbstainError ... } from "./bash-tools.exec..."
    if (
      /^\s*import\s+\{[^}]*ClarityBurstAbstainError[^}]*\}\s+from\s+['"]\.\/bash-tools\.exec(\.js|\.ts)?['"]/.test(
        line
      )
    ) {
      violations.push({ line: lineNumber, content: trimmedLine });
      continue;
    }

    // Also check for imports with relative paths from subdirectories
    // e.g., from "../bash-tools.exec.js" in a subdirectory
    if (
      /^\s*import\s+\{[^}]*ClarityBurstAbstainError[^}]*\}\s+from\s+['"]\.\.\/bash-tools\.exec(\.js|\.ts)?['"]/.test(
        line
      )
    ) {
      violations.push({ line: lineNumber, content: trimmedLine });
      continue;
    }

    // Check for deeper relative imports (../../bash-tools.exec.js)
    if (
      /^\s*import\s+\{[^}]*ClarityBurstAbstainError[^}]*\}\s+from\s+['"]\.\.\/\.\.\/bash-tools\.exec(\.js|\.ts)?['"]/.test(
        line
      )
    ) {
      violations.push({ line: lineNumber, content: trimmedLine });
    }
  }

  return violations;
}

describe("ClarityBurstAbstainError Import Guard", () => {
  const sourceFiles = collectSourceFiles(AGENTS_DIR);

  it("should have source files to check", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  describe("ClarityBurstAbstainError must be imported from ../clarityburst/errors.js", () => {
    for (const filePath of sourceFiles) {
      const relativePath = path.relative(AGENTS_DIR, filePath);
      const fileName = path.basename(filePath);

      it(`${relativePath} should not import ClarityBurstAbstainError from bash-tools.exec`, () => {
        const violations = findBadAbstainErrorImports(filePath, fileName);

        if (violations.length > 0) {
          const violationDetails = violations
            .map((v) => `  Line ${v.line}: ${v.content}`)
            .join("\n");

          expect.fail(
            `\n` +
              `IMPORT SOURCE VIOLATION in ${relativePath}\n` +
              `\n` +
              `ClarityBurstAbstainError MUST be imported from the canonical source:\n` +
              `  ../clarityburst/errors.js\n` +
              `\n` +
              `NOT from the re-export in:\n` +
              `  ./bash-tools.exec.js\n` +
              `\n` +
              `Found ${violations.length} bad import(s):\n` +
              `${violationDetails}\n` +
              `\n` +
              `To fix: Change the import to:\n` +
              `  import { ClarityBurstAbstainError } from "../clarityburst/errors.js";`
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
        REEXPORT_ALLOWLIST.has(path.basename(f))
      ).length;

      console.log(
        `\nClarityBurstAbstainError import guard scanned ${totalFiles} files ` +
          `(${tsFiles} .ts, ${jsFiles} .js/.mjs, ${allowlistedFiles} allowlisted)`
      );

      expect(totalFiles).toBeGreaterThan(0);
    });

    it("should confirm all files use canonical import source", () => {
      const allViolations: Array<{ file: string; line: number; content: string }> = [];

      for (const filePath of sourceFiles) {
        const fileName = path.basename(filePath);
        const violations = findBadAbstainErrorImports(filePath, fileName);
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
          `\nFound ${allViolations.length} ClarityBurstAbstainError import violation(s):\n${summary}`
        );
      }

      expect(allViolations).toHaveLength(0);
    });
  });
});
