/**
 * Lightweight path extractor for the `apply_patch` envelope grammar.
 *
 * The full parser in `apply-patch.ts` validates and applies a patch end-to-end.
 * Plugins running inside `before_tool_call` only need the destination paths so
 * they can compute path policy decisions before the patch is applied. This
 * helper walks the input lines and collects every path mentioned by:
 *
 *   - `*** Add File: <path>`
 *   - `*** Update File: <path>`         (and the optional `*** Move to: <new>`
 *                                         sub-marker that immediately follows)
 *   - `*** Delete File: <path>`
 *
 * Unlike the strict parser, this helper is forgiving: it does not require the
 * `*** Begin Patch` / `*** End Patch` envelope, it ignores non-marker lines
 * while scanning the full input, and it may therefore still pick up marker-like
 * lines that appear later in malformed input or patch bodies. Empty paths are
 * dropped.
 *
 * The shape of the input mirrors how `apply_patch` receives it: either a
 * string (the full patch text) or an object with an `input` field carrying the
 * patch text. Anything else returns an empty array.
 */

const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";

function readPatchText(input: unknown): string | undefined {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input === "object" && "input" in input) {
    const candidate = (input as { input?: unknown }).input;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function pushPath(target: string[], seen: Set<string>, raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) {
    return;
  }
  if (seen.has(trimmed)) {
    return;
  }
  seen.add(trimmed);
  target.push(trimmed);
}

/**
 * Walk an apply_patch envelope and return every destination path found, in
 * the order they appear. Duplicates are de-duplicated (the same file may be
 * referenced multiple times within a single envelope). Returns `[]` for any
 * input that is not a recognised envelope.
 */
export function extractApplyPatchTargetPaths(input: unknown): string[] {
  const text = readPatchText(input);
  if (text === undefined || text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const paths: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.startsWith(ADD_FILE_MARKER)) {
      pushPath(paths, seen, trimmed.slice(ADD_FILE_MARKER.length));
      continue;
    }
    if (trimmed.startsWith(DELETE_FILE_MARKER)) {
      pushPath(paths, seen, trimmed.slice(DELETE_FILE_MARKER.length));
      continue;
    }
    if (trimmed.startsWith(UPDATE_FILE_MARKER)) {
      pushPath(paths, seen, trimmed.slice(UPDATE_FILE_MARKER.length));
      // The Update header may be immediately followed by a `*** Move to:`
      // sub-marker that names the new path. Skip leading blank lines so
      // human-edited patches with extra spacing still pick it up.
      let lookahead = index + 1;
      while (lookahead < lines.length && lines[lookahead].trim() === "") {
        lookahead += 1;
      }
      const candidate = lines[lookahead]?.trim();
      if (candidate?.startsWith(MOVE_TO_MARKER)) {
        pushPath(paths, seen, candidate.slice(MOVE_TO_MARKER.length));
      }
    }
  }
  return paths;
}
