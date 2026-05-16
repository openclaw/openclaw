// Unified-diff renderer for the edit-tool **recovery** result.
//
// The pinned upstream `createEditTool` (from `@earendil-works/pi-coding-agent`)
// already populates `details.diff` on a normal success — the export-html
// template at `src/auto-reply/reply/export-html/template.js` (case "edit",
// around L1144) renders that field as a coloured diff block.  But on the
// `wrapEditToolWithRecovery` recovery branch — where the base tool threw
// AFTER successfully writing the file — the recovery result was always
// emitted with `diff: ""`, so the recovered edit fell through to the plain
// "tool-output" fallback in the template.  See #82015.
//
// This file owns the small line-level diff used by the recovery branch.
// It is deliberately bounded BEFORE doing any quadratic work: an attempted
// diff over an input larger than `DIFF_MAX_INPUT_LINES` returns "" without
// allocating an LCS matrix.  That keeps the recovery branch best-effort and
// non-fatal even on accidental whole-file rewrites — the original recovery
// success result still ships, just without an attached diff.

const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_OUTPUT_LINES = 400; // safety cap on rendered diff lines
const DIFF_MAX_INPUT_LINES = 2000; // pre-LCS guard against quadratic blow-up

function normalizeToLF(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function splitForDiff(value: string): string[] {
  // Empty input → one empty line so a "create from empty" edit still surfaces
  // an all-added hunk.  Trailing newline is preserved as an empty last array
  // element matching `git diff`'s EOF representation.
  return normalizeToLF(value).split("\n");
}

function computeLineLcs(a: string[], b: string[]): number[][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

type DiffOp = { kind: "equal" | "remove" | "add"; line: string };

function buildLineOps(a: string[], b: string[]): DiffOp[] {
  const dp = computeLineLcs(a, b);
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: "equal", line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "remove", line: a[i] });
      i++;
    } else {
      ops.push({ kind: "add", line: b[j] });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "remove", line: a[i++] });
  }
  while (j < b.length) {
    ops.push({ kind: "add", line: b[j++] });
  }
  return ops;
}

type Hunk = {
  aStart: number;
  bStart: number;
  aCount: number;
  bCount: number;
  lines: string[];
};

function buildHunks(ops: DiffOp[]): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let aLine = 1;
  let bLine = 1;
  let trailingEqual = 0;

  const flushHunk = () => {
    if (current && (current.aCount > 0 || current.bCount > 0)) {
      hunks.push(current);
    }
    current = null;
  };

  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === "equal") {
      if (current) {
        current.lines.push(` ${op.line}`);
        current.aCount++;
        current.bCount++;
        trailingEqual++;
        if (trailingEqual >= DIFF_CONTEXT_LINES * 2) {
          // Trim trailing context beyond DIFF_CONTEXT_LINES and close the hunk.
          const overshoot = trailingEqual - DIFF_CONTEXT_LINES;
          current.lines.splice(current.lines.length - overshoot, overshoot);
          current.aCount -= overshoot;
          current.bCount -= overshoot;
          flushHunk();
          trailingEqual = 0;
        }
      }
      aLine++;
      bLine++;
    } else {
      if (!current) {
        // Backfill up to DIFF_CONTEXT_LINES lines of prior context so the
        // hunk shows context-before.
        const contextBack: string[] = [];
        let look = k - 1;
        while (look >= 0 && ops[look].kind === "equal" && contextBack.length < DIFF_CONTEXT_LINES) {
          contextBack.unshift(` ${ops[look].line}`);
          look--;
        }
        current = {
          aStart: aLine - contextBack.length,
          bStart: bLine - contextBack.length,
          aCount: contextBack.length,
          bCount: contextBack.length,
          lines: [...contextBack],
        };
      }
      if (op.kind === "remove") {
        current.lines.push(`-${op.line}`);
        current.aCount++;
        aLine++;
      } else {
        current.lines.push(`+${op.line}`);
        current.bCount++;
        bLine++;
      }
      trailingEqual = 0;
    }
  }
  flushHunk();
  return hunks;
}

/**
 * Render a compact unified diff between `oldText` and `newText`.
 *
 * Returns "" when:
 *   - the inputs are byte-identical (no diff worth showing)
 *   - either side has more than `DIFF_MAX_INPUT_LINES` lines (pre-LCS guard;
 *     the recovery branch then ships the success result without a diff)
 *
 * The rendered diff is capped at `DIFF_MAX_OUTPUT_LINES` so an accidental
 * whole-file rewrite under the input cap still does not blow up the
 * rendered footer; when truncated, a trailing `... (N more lines)` marker
 * is appended.
 */
export function buildEditDiff(oldText: string, newText: string, filePath: string): string {
  if (oldText === newText) {
    return "";
  }

  const aLines = splitForDiff(oldText);
  const bLines = splitForDiff(newText);

  // Pre-LCS guard.  computeLineLcs would otherwise allocate an
  // (aLines+1) * (bLines+1) matrix; on a multi-megabyte file that's
  // millions of entries and can hang or OOM the recovery branch.  Return
  // "" so the caller surfaces today's empty-diff recovery success — better
  // than crashing or stalling the agent run.
  if (aLines.length > DIFF_MAX_INPUT_LINES || bLines.length > DIFF_MAX_INPUT_LINES) {
    return "";
  }

  const ops = buildLineOps(aLines, bLines);
  const hunks = buildHunks(ops);
  if (hunks.length === 0) {
    return "";
  }

  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const body: string[] = [];
  for (const h of hunks) {
    body.push(`@@ -${h.aStart},${h.aCount} +${h.bStart},${h.bCount} @@`);
    for (const line of h.lines) {
      body.push(line);
    }
  }

  let lines = [...header, ...body];
  if (lines.length > DIFF_MAX_OUTPUT_LINES) {
    const trimmed = lines.slice(0, DIFF_MAX_OUTPUT_LINES);
    trimmed.push(`... (${lines.length - DIFF_MAX_OUTPUT_LINES} more lines)`);
    lines = trimmed;
  }
  return lines.join("\n");
}
