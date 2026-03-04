/**
 * Regression tests for the JSON escape-sequence repair middleware in monitor.ts.
 *
 * Background
 * ----------
 * Some Bot Framework clients send activity payloads with invalid JSON escape
 * sequences such as bare backslashes followed by characters not defined in
 * RFC 8259 (e.g. \p, \q, \c).  The original `express.json()` strict parser
 * threw SyntaxError on such payloads, which caused non-200 responses and put
 * Azure Bot Service into exponential backoff, silently dropping all subsequent
 * messages.
 *
 * The fix in monitor.ts replaces `express.json()` with `express.raw()` and a
 * two-pass repair middleware using `repairJsonEscapes()`.  These tests verify
 * the repair logic directly.
 */

import { describe, it, expect } from "vitest";

// ── Mirror `repairJsonEscapes` from monitor.ts ─────────────────────────────
// Alternation: consume valid \\\\ pairs first, then repair lone bare escapes.
const REPAIR_BARE_ESCAPE_RE = /(\\.)+|\\([^"\\/bfnrtu])/g;

function repairJsonEscapes(raw: string): string {
  return raw.replace(
    REPAIR_BARE_ESCAPE_RE,
    (match: string, _doubled: string | undefined, invalid: string | undefined) =>
      invalid !== undefined ? "\\\\" + invalid : match,
  );
}

/** Emulate the two-pass middleware. Returns parsed body + which pass was used. */
function twoPassParse(raw: string): { body: unknown; path: "first_pass" | "repaired" } {
  try {
    return { body: JSON.parse(raw), path: "first_pass" };
  } catch {
    const fixed = repairJsonEscapes(raw);
    return { body: JSON.parse(fixed), path: "repaired" }; // throws if still invalid
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────────

/** conversationUpdate with bare \p inside a JSON string — invalid per RFC 8259 */
const BAD_ESCAPE_PAYLOAD = String.raw`{
  "type": "conversationUpdate",
  "channelData": {
    "team": {"id": "19:meeting\participant@thread.v2", "name": "Test\Project"}
  }
}`;

/** Well-formed message activity — must parse on first pass unchanged */
const GOOD_MESSAGE_PAYLOAD = JSON.stringify({
  type: "message",
  text: "Hello",
  // Windows path with proper double-backslash — already valid JSON
  channelData: { path: "C:\\Users\\test" },
});

/** Valid JSON escape sequences — must NOT be double-escaped */
const VALID_ESCAPES_PAYLOAD = String.raw`{"text": "line1\nline2\ttab\"quote\\backslash"}`;

/**
 * The Greptile-identified edge case: a valid \\q sequence (JSON for literal \q)
 * mixed with a separate invalid escape in the same payload.
 * The old regex /\\([^"\\/bfnrtu])/g would corrupt the \\q → \\\\q.
 */
const MIXED_VALID_AND_INVALID_ESCAPES = String.raw`{
  "path": "C:\\q",
  "team": "Test\Project"
}`;

// ── Tests ──────────────────────────────────────────────────────────────────

describe("msteams JSON repair middleware", () => {
  it("standard JSON.parse() throws SyntaxError on bare-backslash escape sequences", () => {
    expect(() => JSON.parse(BAD_ESCAPE_PAYLOAD)).toThrow(SyntaxError);
  });

  it("two-pass repair recovers activities with bare-backslash escape sequences", () => {
    const { body, path } = twoPassParse(BAD_ESCAPE_PAYLOAD);
    expect(path).toBe("repaired");
    const activity = body as Record<string, unknown>;
    expect(activity["type"]).toBe("conversationUpdate");
    // After repair: \P → \\P in JSON → literal backslash + P in parsed value
    const cd = activity["channelData"] as Record<string, unknown>;
    const team = cd["team"] as Record<string, string>;
    expect(team["name"]).toBe("Test\\Project");
  });

  it("well-formed message payloads pass through on the first parse without repair", () => {
    const { body, path } = twoPassParse(GOOD_MESSAGE_PAYLOAD);
    expect(path).toBe("first_pass");
    const activity = body as Record<string, unknown>;
    expect(activity["text"]).toBe("Hello");
  });

  it("valid JSON escape sequences (\\n \\t \\\\ etc.) are preserved and not double-escaped", () => {
    const { body, path } = twoPassParse(VALID_ESCAPES_PAYLOAD);
    expect(path).toBe("first_pass");
    const obj = body as Record<string, string>;
    expect(obj["text"]).toBe("line1\nline2\ttab\"quote\\backslash");
  });

  it("completely malformed JSON is re-thrown (caller returns HTTP 200 to prevent backoff)", () => {
    expect(() => twoPassParse("{ not valid json at all ??? }")).toThrow(SyntaxError);
  });

  it("[regression] valid \\\\q sequence is NOT corrupted when another field has a bare-backslash escape", () => {
    // Greptile edge case: mixing a valid \\q (literal \q) with an invalid \P.
    // Old regex misidentified the second \\ of the \\q pair as a bare-backslash
    // escape and turned \\q → \\\\q (wrong field value).
    const { body, path } = twoPassParse(MIXED_VALID_AND_INVALID_ESCAPES);
    expect(path).toBe("repaired");
    const obj = body as Record<string, string>;
    // "C:\\q" in JSON → literal string C:\q (single backslash + q)
    expect(obj["path"]).toBe("C:\\q");
    // "Test\Project" in JSON (invalid) → repaired to "Test\\Project" → literal Test\Project
    expect(obj["team"]).toBe("Test\\Project");
  });
});
