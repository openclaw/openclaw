/**
 * @fileoverview
 * Anti-regression check: Ensures no agent/runtime production code directly calls
 * callGatewayTool("node.invoke", ...) outside the centralized wrapper.
 *
 * This test scans all agent/runtime production TypeScript files and fails if any
 * direct callGatewayTool("node.invoke", ...) patterns are found outside the
 * approved wrapper file (node-invoke-guard.ts).
 *
 * ENFORCEMENT RULE:
 * ────────────────
 * - All agent/runtime code MUST dispatch node.invoke through dispatchNodeInvokeGuarded()
 * - ONLY node-invoke-guard.ts is allowed to call callGatewayTool("node.invoke", ...)
 * - TEST/CLI/gateway-internal files are excluded from this check
 * - Violation: FAIL (prevents merge)
 *
 * SCOPE:
 * ──────
 * Production files: src/agents/*.ts, src/agents/tools/*.ts (non-test)
 * Excluded:
 *   - *.test.ts, *.e2e.test.ts (test files)
 *   - node-invoke-guard.ts (approved wrapper)
 *   - bash-tools.exec.ts, bash-tools.exec-*.ts except bash-tools.exec-host-node.ts (CLI/operator scope)
 *   - gateway.ts (gateway transport)
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("Anti-regression: node.invoke gating enforcement", () => {
  it("should not allow direct callGatewayTool('node.invoke', ...) outside node-invoke-guard.ts", () => {
    const currentFile = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFile);
    const repoRoot = resolve(currentDir, "../..");

    // Files/patterns that are allowed to call callGatewayTool("node.invoke", ...)
    const allowedFiles = new Set([
      "node-invoke-guard.ts", // Approved wrapper
      "gateway.ts", // Gateway transport layer
    ]);

    // Files/patterns to exclude from check (test, CLI, operator scope)
    const excludePatterns = [
      /\.test\.ts$/,
      /\.e2e\.test\.ts$/,
      /bash-tools\.exec\.ts$/,
      /bash-tools\.exec-approval-request\.ts$/,
      /bash-tools\.exec-gateway\.ts$/,
      /bash-tools\.exec-runtime\.ts$/,
      /bash-tools\.exec-types\.ts$/,
    ];

    function walkDir(dir: string, callback: (file: string) => void) {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath, callback);
        } else if (entry.name.endsWith(".ts")) {
          callback(fullPath);
        }
      }
    }

    // Find all agent/runtime production TypeScript files
    const agentFiles: string[] = [];
    const agentsDir = resolve(repoRoot, "src/agents");
    walkDir(agentsDir, (file) => {
      const baseName = file.split(/[\\/]/).pop() || "";

      // Skip if matches exclude patterns
      if (excludePatterns.some((pattern) => pattern.test(file))) {
        return;
      }

      // Skip if in allowed list
      if (allowedFiles.has(baseName)) {
        return;
      }

      agentFiles.push(file);
    });

    const violations: Array<{
      file: string;
      line: number;
      match: string;
    }> = [];

    for (const file of agentFiles) {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      // Pattern: callGatewayTool with "node.invoke" as first string argument
      // Matches: callGatewayTool("node.invoke", ...), callGatewayTool('node.invoke', ...)
      const pattern = /callGatewayTool\s*\(\s*["']node\.invoke["']/;

      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          violations.push({
            file,
            line: idx + 1,
            match: line.trim(),
          });
        }
      });
    }

    // Format violation report
    if (violations.length > 0) {
      const report = violations
        .map((v) => {
          const relPath = v.file.replace(repoRoot, "").replace(/^\\/,"").replace(/^\//,"");
          return `  ${relPath}:${v.line}\n    ${v.match}`;
        })
        .join("\n");

      expect.fail(
        `Found ${violations.length} direct callGatewayTool("node.invoke", ...) call(s) outside node-invoke-guard.ts.\n` +
          `All agent/runtime code MUST use dispatchNodeInvokeGuarded() instead.\n\n` +
          `Violations:\n${report}\n\n` +
          `Fix: Replace direct callGatewayTool("node.invoke", ...) with dispatchNodeInvokeGuarded()`,
      );
    }

    // Success: no violations found
    expect(violations).toHaveLength(0);
  });
});
