/**
 * markdown-code-fence-lint.ts
 *
 * Lint and auto-fix code fences in markdown content at write time.
 * Related: #37625
 *
 * Design:
 *  - Detects unfenced code blocks and bare code lines
 *  - Auto-fixes by wrapping with fenced code blocks (default)
 *  - Infers language tag when missing from an existing fence
 *  - Skippable per-call via options
 */

export interface CodeFenceChange {
  /** Line number (1-indexed) where change starts */
  line: number;
  /** Human-readable description of what was changed */
  description: string;
}

export interface CodeFenceLintResult {
  /** Content after fixes applied (same as input when no changes) */
  fixed: string;
  /** List of changes made */
  changes: CodeFenceChange[];
}

export interface CodeFenceLintOptions {
  /**
   * "fix"  — auto-fix issues (default)
   * "warn" — return changes list but do not modify content
   */
  mode?: "fix" | "warn";
}

// ---------------------------------------------------------------------------
// Language inference
// ---------------------------------------------------------------------------

const SHELL_TOKENS = /^(\$|#!|npm |yarn |pnpm |git |curl |wget |cd |ls |mkdir |rm |cp |mv |cat |echo |export |source |sudo |apt |brew |docker )/;
const TS_TOKENS = /^(const |let |var |function |class |import |export |interface |type |async |await |=>|@)/;
const PYTHON_TOKENS = /^(def |import |from |class |print\(|if __name__|async def )/;
const JSON_PATTERN = /^[{[]/;

function inferLanguage(lines: string[]): string {
  const sample = lines.slice(0, 5).join("\n");
  const first = lines[0]?.trimStart() ?? "";

  if (SHELL_TOKENS.test(first)) return "sh";
  if (TS_TOKENS.test(first)) return "ts";
  if (PYTHON_TOKENS.test(first)) return "python";
  if (JSON_PATTERN.test(first) && isLikelyJson(sample)) return "json";
  return "text";
}

function isLikelyJson(s: string): boolean {
  try {
    JSON.parse(s);
    return true;
  } catch {
    // heuristic fallback: contains "key": pattern
    return /"[^"]+"\s*:/.test(s);
  }
}

// ---------------------------------------------------------------------------
// Unfenced code detection heuristics
// ---------------------------------------------------------------------------

/** Returns true if a line looks like bare code that should be fenced. */
function looksLikeCode(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;

  // Shell prompt or shebang
  if (/^(\$ |#!\/|npm |yarn |pnpm |git |curl |wget )/.test(trimmed)) return true;

  // TypeScript / JavaScript
  if (/^(const |let |var |function |class |import |export |interface |type |async |=>)/.test(trimmed)) return true;

  // Python
  if (/^(def |from [a-z]|class [A-Z]|print\()/.test(trimmed)) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Core lint pass
// ---------------------------------------------------------------------------

export function lintMarkdownCodeFences(
  content: string,
  options: CodeFenceLintOptions = {},
): CodeFenceLintResult {
  const mode = options.mode ?? "fix";
  const changes: CodeFenceChange[] = [];
  const inputLines = content.split("\n");
  const outputLines: string[] = [];

  let i = 0;
  let inFence = false;
  let fenceLang = "";
  let fenceDelimiter = "";

  while (i < inputLines.length) {
    const raw = inputLines[i];
    const trimmed = raw.trimStart();

    // Track fence open/close
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})(\w*)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceDelimiter = fenceMatch[1];
        fenceLang = fenceMatch[2];

        // Fix: missing language tag on opening fence
        if (!fenceLang) {
          // Collect the fenced block to infer language
          const blockLines: string[] = [];
          let j = i + 1;
          while (j < inputLines.length) {
            const inner = inputLines[j].trimStart();
            if (inner.startsWith(fenceDelimiter)) break;
            blockLines.push(inputLines[j]);
            j++;
          }
          const inferred = inferLanguage(blockLines);
          const fixed = raw.replace(fenceMatch[1], fenceMatch[1] + inferred);
          changes.push({
            line: i + 1,
            description: `Added missing language tag \`${inferred}\` to code fence`,
          });
          outputLines.push(mode === "fix" ? fixed : raw);
          i++;
          continue;
        }
      } else if (trimmed.startsWith(fenceDelimiter)) {
        inFence = false;
        fenceLang = "";
        fenceDelimiter = "";
      }

      outputLines.push(raw);
      i++;
      continue;
    }

    // Inside a fence — pass through unchanged
    if (inFence) {
      outputLines.push(raw);
      i++;
      continue;
    }

    // Outside a fence — check for unfenced code block (≥2 consecutive matching lines)
    if (looksLikeCode(trimmed)) {
      // Collect consecutive code-looking lines
      const codeLines: string[] = [raw];
      let j = i + 1;
      while (j < inputLines.length && looksLikeCode(inputLines[j].trimStart())) {
        codeLines.push(inputLines[j]);
        j++;
      }

      if (codeLines.length >= 1) {
        const lang = inferLanguage(codeLines.map((l) => l.trimStart()));
        changes.push({
          line: i + 1,
          description: `Wrapped ${codeLines.length} unfenced code line(s) with \`\`\`${lang} fence`,
        });
        if (mode === "fix") {
          outputLines.push("```" + lang);
          outputLines.push(...codeLines);
          outputLines.push("```");
        } else {
          outputLines.push(...codeLines);
        }
        i = j;
        continue;
      }
    }

    outputLines.push(raw);
    i++;
  }

  return {
    fixed: mode === "fix" ? outputLines.join("\n") : content,
    changes,
  };
}
