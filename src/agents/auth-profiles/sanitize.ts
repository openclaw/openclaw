/**
 * Canonical sanitizer for auth profile IDs before embedding in terminal/log
 * output. Strips ANSI escape sequences and control characters to prevent
 * terminal injection (log forging) via maliciously crafted profile IDs.
 *
 * Handles:
 *   - Standard CSI:  ESC [ ... final        e.g. \x1b[31m, \x1b[1;32m
 *   - Private CSI:   ESC [ ? ... final       e.g. \x1b[?25l (cursor hide)
 *   - OSC:           ESC ] ... BEL/ST        e.g. \x1b]0;title\x07
 *   - DCS/SOS/PM/APC: ESC P/X/^/_ ... ST   e.g. \x1bPdata\x1b\\
 *   - Other Fe:      ESC <single char>       e.g. \x1bc (RIS reset)
 *   - Bare ESC:      ESC at end of string    e.g. "myprofile\x1b"
 *   - C0 controls:   U+0000-U+001F          (includes CR, LF, TAB, etc.)
 *   - DEL:           U+007F
 *   - C1 controls:   U+0080-U+009F          (includes 8-bit CSI \x9b)
 */
export function sanitizeProfileIdForDisplay(id: string): string {
  return (
    id
      // Strip 7-bit ESC-prefixed ANSI/VT control sequences (CSI, OSC, DCS, APC, PM, SOS,
      // private-use, and bare ESC + any char) to prevent terminal injection via profile IDs.
      .replace(
        // eslint-disable-next-line no-control-regex -- intentional: regex must match control chars to strip them
        /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[\s\S]?)/g,
        "",
      )
      // Strip C0 controls (U+0000-U+001F), DEL (U+007F), and C1 controls (U+0080-U+009F).
      // C1 includes \x9b which can construct CSI sequences on xterm-compatible terminals
      // without a leading ESC byte, bypassing the 7-bit escape strip above.
      // C0 includes CR/LF so no separate newline strip is needed.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f\u0080-\u009f]/g, "")
  );
}

// Generous upper bound to stop pathological multi-KB keys without rejecting any
// realistic provider:label profile ID.
const MAX_PROFILE_ID_LENGTH = 512;
const RESERVED_PROFILE_IDS = new Set(["__proto__", "constructor", "prototype"]);
// Control chars (C0/C1), DEL, and 8-bit CSI enable terminal/log injection when a
// profile ID is echoed. These are the only characters that are genuinely unsafe
// in an ID; everything else is a legitimate arbitrary object key.
// eslint-disable-next-line no-control-regex -- intentional: must match control chars to reject them
const PROFILE_ID_CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f\u0080-\u009f]/;

/**
 * Validate a profile ID at the CLI input boundary. Auth profile IDs are
 * arbitrary string keys in config and the store, so this only rejects the
 * genuinely unsafe cases — empty, prototype-pollution reserved names, control/
 * escape characters (terminal/log injection), and pathologically long values —
 * while preserving the existing free-form ID contract so any pre-existing
 * profile can still be targeted. Display output is separately sanitized via
 * {@link sanitizeProfileIdForDisplay}.
 *
 * @returns null when valid, or a human-readable error string when invalid.
 */
export function validateProfileId(id: string): string | null {
  if (!id) {
    return "Profile ID must not be empty.";
  }
  if (id.length > MAX_PROFILE_ID_LENGTH) {
    return `Profile ID must be at most ${MAX_PROFILE_ID_LENGTH} characters (got ${id.length}).`;
  }
  if (RESERVED_PROFILE_IDS.has(id)) {
    return `Profile ID '${id}' is reserved and may not be used.`;
  }
  if (PROFILE_ID_CONTROL_CHAR_PATTERN.test(id)) {
    return "Profile ID may not contain control or escape characters.";
  }
  return null;
}
