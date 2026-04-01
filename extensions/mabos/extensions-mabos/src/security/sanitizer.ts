/**
 * Content sanitizer — neutralizes detected injection/exfiltration payloads
 * while preserving the surrounding text.
 */

import type { ScanFinding, ThreatLevel } from "./types.js";

const THREAT_SEVERITY: Record<ThreatLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export class Sanitizer {
  /**
   * Neutralize detected threats in text by replacing matched segments.
   * Higher-threat findings are fully redacted; lower ones are escaped.
   */
  neutralize(text: string, findings: ScanFinding[]): string {
    if (findings.length === 0) return text;

    // Sort findings by position (descending) to replace from end to start
    // without invalidating earlier positions.
    const sorted = [...findings].sort((a, b) => b.position - a.position);

    let result = text;
    for (const finding of sorted) {
      const severity = THREAT_SEVERITY[finding.threat] ?? 0;

      if (severity >= THREAT_SEVERITY.high) {
        // Full redaction for high/critical threats
        result =
          result.slice(0, finding.position) +
          `[REDACTED:${finding.pattern}]` +
          result.slice(finding.position + finding.match.length);
      } else {
        // Escape for medium/low threats — insert zero-width space to break patterns
        const escaped = finding.match.split("").join("\u200C");
        result =
          result.slice(0, finding.position) +
          escaped +
          result.slice(finding.position + finding.match.length);
      }
    }

    return result;
  }

  /**
   * Strip invisible Unicode characters used for steganographic injection.
   */
  stripInvisible(text: string): string {
    return text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF\u00AD\u200C]/g, "");
  }

  /**
   * Escape prompt delimiter sequences that could break model context.
   */
  escapeDelimiters(text: string): string {
    return text
      .replace(/<\/?system>/gi, "[system-tag]")
      .replace(/<\|im_start\|>/gi, "[im-start]")
      .replace(/<\|im_end\|>/gi, "[im-end]")
      .replace(/\[INST\]/gi, "[inst-tag]")
      .replace(/\[\/INST\]/gi, "[/inst-tag]");
  }

  /**
   * Sanitize external content before injecting into agent memory or context.
   * Applies all sanitization layers.
   *
   * Order matters: neutralize first (findings have positions against original text),
   * then strip invisible chars and escape delimiters on the already-neutralized result.
   */
  sanitizeExternal(text: string, findings?: ScanFinding[]): string {
    // 1. Neutralize scan findings first — positions are relative to the original text
    let result = text;
    if (findings && findings.length > 0) {
      result = this.neutralize(result, findings);
    }
    // 2. Strip invisible characters (may have been introduced or already present)
    result = this.stripInvisible(result);
    // 3. Escape any remaining delimiter sequences
    result = this.escapeDelimiters(result);
    return result;
  }
}
