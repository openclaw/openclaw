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
      // eslint-disable-next-line no-control-regex
      .replace(
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

/** Safe character set for profile IDs: letters, digits, `.`, `_`, `:`, `-`, `@`. */
const PROFILE_ID_PATTERN = /^[a-zA-Z0-9._:\-@]{1,64}$/;

/**
 * Validate a profile ID string against a safe character set at the CLI input
 * boundary. Rejects control characters, ANSI sequences, and any character
 * outside the allowed set before the value reaches deeper auth logic.
 *
 * @returns null when valid, or a human-readable error string when invalid.
 */
export function validateProfileId(id: string): string | null {
  if (!id) {
    return "Profile ID must not be empty.";
  }
  if (id.length > 64) {
    return `Profile ID must be at most 64 characters (got ${id.length}).`;
  }
  if (!PROFILE_ID_PATTERN.test(id)) {
    return "Profile ID may only contain letters, digits, '.', '_', ':', '-', and '@'.";
  }
  return null;
}
