/**
 * Diff-only validator for code/document modifications.
 *
 * When a TaskEnvelope (or subagent task) involves modifying code or documents,
 * executors MUST return unified diff format — not full file rewrites.
 *
 * This module detects when an output looks like a full-file rewrite rather
 * than a diff, and rejects it.
 */

export type DiffValidationResult =
  | { valid: true }
  | {
      valid: false;
      reason: string;
      suggestion: string;
    };

/**
 * Heuristic patterns that indicate a unified diff.
 */
const UNIFIED_DIFF_MARKERS = [
  /^---\s+\S/m, // --- a/file
  /^\+\+\+\s+\S/m, // +++ b/file
  /^@@\s+-\d+/m, // @@ -N,M +N,M @@
];

/**
 * Heuristic patterns that indicate JSON patch (RFC 6902).
 */
const JSON_PATCH_MARKERS = [
  /^\s*\[\s*\{/, // starts with [{
  /"op"\s*:\s*"(add|remove|replace|move|copy|test)"/, // has op field
  /"path"\s*:\s*"\//, // has JSON pointer path
];

/**
 * Patterns that suggest full-file content (code blocks, complete files).
 */
const FULL_FILE_INDICATORS = [
  /^```[\w]*\n[\s\S]{500,}\n```$/m, // Large fenced code block
  /^(import|from|const|let|var|function|class|export|module|require|package)\s/m, // Code file start
];

/**
 * Check whether a string looks like a unified diff.
 */
export function looksLikeUnifiedDiff(text: string): boolean {
  const matchCount = UNIFIED_DIFF_MARKERS.filter((re) => re.test(text)).length;
  return matchCount >= 2; // need at least 2 of 3 markers
}

/**
 * Check whether a string looks like a JSON patch.
 */
export function looksLikeJsonPatch(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("[")) return false;
  const matchCount = JSON_PATCH_MARKERS.filter((re) => re.test(trimmed)).length;
  return matchCount >= 2;
}

/**
 * Check whether a string looks like a full file rewrite (not a diff).
 */
export function looksLikeFullFileRewrite(text: string): boolean {
  // If it looks like a diff, it's not a full rewrite
  if (looksLikeUnifiedDiff(text)) return false;
  if (looksLikeJsonPatch(text)) return false;

  // Count lines that look like unchanged source code (no +/- prefix)
  const lines = text.split("\n");
  const totalLines = lines.length;

  if (totalLines < 10) return false; // too short to judge

  // Count lines that start with diff markers vs plain code
  let diffPrefixed = 0;
  let codeLike = 0;

  for (const line of lines) {
    if (/^[+-]/.test(line) || /^@@/.test(line) || /^(---|\+\+\+)/.test(line)) {
      diffPrefixed++;
    } else if (line.trim().length > 0) {
      codeLike++;
    }
  }

  // If less than 10% of content lines are diff-prefixed, it's likely a full rewrite
  const total = diffPrefixed + codeLike;
  if (total === 0) return false;

  const diffRatio = diffPrefixed / total;
  return diffRatio < 0.1 && codeLike > 15;
}

/**
 * Detect whether the task description implies code/document modification.
 */
export function isCodeModificationTask(taskDescription: string): boolean {
  const lower = taskDescription.toLowerCase();
  const modificationVerbs = [
    "modify",
    "update",
    "change",
    "edit",
    "fix",
    "refactor",
    "patch",
    "rewrite",
    "rename",
    "move",
    "replace",
    "add to",
    "remove from",
    "delete from",
    "insert",
    "append",
    "prepend",
  ];

  const codeNouns = [
    "code",
    "file",
    "function",
    "class",
    "method",
    "module",
    "component",
    "script",
    "source",
    "implementation",
    ".ts",
    ".js",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".tsx",
    ".jsx",
    ".css",
    ".html",
    ".md",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
  ];

  const hasModificationVerb = modificationVerbs.some((v) => lower.includes(v));
  const hasCodeNoun = codeNouns.some((n) => lower.includes(n));

  return hasModificationVerb && hasCodeNoun;
}

/**
 * Validate that an executor output uses diff format when modifying code.
 *
 * Returns a validation result indicating pass or fail with reason.
 *
 * @param output - The executor's output text
 * @param taskDescription - Description of the task (used to detect code modification intent)
 * @param forceCheck - If true, skip task heuristic and always validate for diff format
 */
export function validateDiffOnly(params: {
  output: string;
  taskDescription?: string;
  forceCheck?: boolean;
}): DiffValidationResult {
  const { output, taskDescription, forceCheck } = params;

  // If not a code modification task and not forced, skip validation
  if (!forceCheck && taskDescription && !isCodeModificationTask(taskDescription)) {
    return { valid: true };
  }

  // Empty output is trivially valid
  if (!output.trim()) {
    return { valid: true };
  }

  // If it's a valid diff format, pass
  if (looksLikeUnifiedDiff(output)) {
    return { valid: true };
  }

  // If it's a valid JSON patch, pass
  if (looksLikeJsonPatch(output)) {
    return { valid: true };
  }

  // Check if it looks like a full file rewrite
  if (looksLikeFullFileRewrite(output)) {
    return {
      valid: false,
      reason:
        "Output appears to be a full file rewrite. Executors must return unified diff or JSON patch when modifying code.",
      suggestion: [
        "Return a unified diff instead:",
        "--- a/path/to/file",
        "+++ b/path/to/file",
        "@@ -line,count +line,count @@",
        " context line",
        "-removed line",
        "+added line",
      ].join("\n"),
    };
  }

  // Short non-diff output that isn't a full file is acceptable
  // (could be a summary, explanation, or tool call result)
  return { valid: true };
}

/**
 * Extract file paths from a unified diff output.
 */
export function extractDiffFilePaths(diff: string): string[] {
  const paths = new Set<string>();

  for (const line of diff.split("\n")) {
    // Match --- a/path or +++ b/path
    const match = line.match(/^(?:---|\+\+\+)\s+([ab]\/)?(.+)$/);
    if (match) {
      const filePath = match[2]?.trim();
      if (filePath && filePath !== "/dev/null") {
        paths.add(filePath);
      }
    }
  }

  return [...paths];
}
