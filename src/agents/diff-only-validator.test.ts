import { describe, expect, it } from "vitest";
import {
  extractDiffFilePaths,
  isCodeModificationTask,
  looksLikeFullFileRewrite,
  looksLikeJsonPatch,
  looksLikeUnifiedDiff,
  validateDiffOnly,
} from "./diff-only-validator.js";

describe("looksLikeUnifiedDiff", () => {
  it("detects valid unified diff", () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -12,6 +12,9 @@
 def handler():
+    if not config.enabled:
+        return None`;
    expect(looksLikeUnifiedDiff(diff)).toBe(true);
  });

  it("rejects plain text", () => {
    expect(looksLikeUnifiedDiff("Hello, this is a regular message")).toBe(false);
  });

  it("rejects code without diff markers", () => {
    const code = `function main() {
  console.log("hello");
  return 0;
}`;
    expect(looksLikeUnifiedDiff(code)).toBe(false);
  });

  it("requires at least 2 markers", () => {
    // Only has --- line
    expect(looksLikeUnifiedDiff("--- a/file.ts\nsome text")).toBe(false);
  });
});

describe("looksLikeJsonPatch", () => {
  it("detects valid JSON patch", () => {
    const patch = `[
  {"op": "replace", "path": "/name", "value": "new-name"},
  {"op": "add", "path": "/items/-", "value": "item3"}
]`;
    expect(looksLikeJsonPatch(patch)).toBe(true);
  });

  it("rejects regular JSON", () => {
    expect(looksLikeJsonPatch('{"name": "test"}')).toBe(false);
  });

  it("rejects non-JSON", () => {
    expect(looksLikeJsonPatch("just some text")).toBe(false);
  });
});

describe("looksLikeFullFileRewrite", () => {
  it("detects large code blocks as rewrites", () => {
    // Generate a realistic-looking code file with many lines
    const lines = [];
    lines.push("import fs from 'node:fs';");
    lines.push("import path from 'node:path';");
    lines.push("");
    for (let i = 0; i < 30; i++) {
      lines.push(`function handler${i}() {`);
      lines.push(`  console.log("handler ${i}");`);
      lines.push(`  return ${i};`);
      lines.push("}");
      lines.push("");
    }
    const fullFile = lines.join("\n");
    expect(looksLikeFullFileRewrite(fullFile)).toBe(true);
  });

  it("does not flag unified diffs", () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -12,6 +12,9 @@
 context line 1
 context line 2
-old line
+new line
 context line 3
 context line 4`;
    expect(looksLikeFullFileRewrite(diff)).toBe(false);
  });

  it("does not flag short snippets", () => {
    const snippet = `const x = 1;
const y = 2;`;
    expect(looksLikeFullFileRewrite(snippet)).toBe(false);
  });
});

describe("isCodeModificationTask", () => {
  it("detects code modification tasks", () => {
    expect(isCodeModificationTask("modify the handler function in main.ts")).toBe(true);
    expect(isCodeModificationTask("update the config.json file")).toBe(true);
    expect(isCodeModificationTask("fix the bug in utils.py")).toBe(true);
    expect(isCodeModificationTask("refactor the module code")).toBe(true);
    expect(isCodeModificationTask("edit the source file")).toBe(true);
  });

  it("does not flag non-modification tasks", () => {
    expect(isCodeModificationTask("explain the algorithm")).toBe(false);
    expect(isCodeModificationTask("list all running processes")).toBe(false);
    expect(isCodeModificationTask("what is the weather today")).toBe(false);
  });

  it("does not flag tasks without code context", () => {
    expect(isCodeModificationTask("update my calendar")).toBe(false);
    expect(isCodeModificationTask("change the meeting time")).toBe(false);
  });
});

describe("validateDiffOnly", () => {
  it("passes for valid unified diff when task is code modification", () => {
    const result = validateDiffOnly({
      output: `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 export { x };`,
      taskDescription: "modify the code in main.ts",
    });
    expect(result.valid).toBe(true);
  });

  it("passes for JSON patch", () => {
    const result = validateDiffOnly({
      output: `[{"op": "replace", "path": "/name", "value": "new"}]`,
      taskDescription: "update the config.json file",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects full file rewrite for code modification task", () => {
    const lines = [];
    lines.push("import fs from 'node:fs';");
    for (let i = 0; i < 30; i++) {
      lines.push(`function f${i}() { return ${i}; }`);
    }
    const result = validateDiffOnly({
      output: lines.join("\n"),
      taskDescription: "modify the code in handler.ts",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain("full file rewrite");
      expect(result.suggestion).toContain("unified diff");
    }
  });

  it("skips validation for non-code tasks", () => {
    const result = validateDiffOnly({
      output: "Here is a long explanation of the algorithm...",
      taskDescription: "explain the sorting algorithm",
    });
    expect(result.valid).toBe(true);
  });

  it("validates when forceCheck is true regardless of task", () => {
    const lines = [];
    lines.push("import os from 'node:os';");
    for (let i = 0; i < 30; i++) {
      lines.push(`const val${i} = ${i};`);
    }
    const result = validateDiffOnly({
      output: lines.join("\n"),
      forceCheck: true,
    });
    expect(result.valid).toBe(false);
  });

  it("passes empty output", () => {
    const result = validateDiffOnly({
      output: "",
      taskDescription: "modify the code",
      forceCheck: true,
    });
    expect(result.valid).toBe(true);
  });

  it("passes short non-diff output (summaries/explanations)", () => {
    const result = validateDiffOnly({
      output: "Done. The function has been updated.",
      taskDescription: "modify the code in main.ts",
    });
    expect(result.valid).toBe(true);
  });
});

describe("extractDiffFilePaths", () => {
  it("extracts file paths from unified diff", () => {
    const diff = `--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
--- a/src/utils.ts
+++ b/src/utils.ts
@@ -5,2 +5,3 @@
 export function helper() {}
+export function newHelper() {}`;
    const paths = extractDiffFilePaths(diff);
    expect(paths).toContain("src/main.ts");
    expect(paths).toContain("src/utils.ts");
    expect(paths).toHaveLength(2); // deduplicated
  });

  it("excludes /dev/null", () => {
    const diff = `--- /dev/null
+++ b/src/new-file.ts
@@ -0,0 +1,3 @@
+const x = 1;`;
    const paths = extractDiffFilePaths(diff);
    expect(paths).toContain("src/new-file.ts");
    expect(paths).not.toContain("/dev/null");
  });

  it("returns empty array for non-diff text", () => {
    expect(extractDiffFilePaths("just some text")).toEqual([]);
  });
});
