// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The OpenClaw Authors.
//
// Adapted from kelliott-cloud/Nexus-10.0-A under operator-granted re-license.
// Original: backend/data_guard.py + backend/security/dlp_detectors/regex_detector.py
//
// Regex-based DLP detector covering the 8 entity types asked for in the
// OpenClaw governance plugin spec. Presidio Node bindings are not currently
// published by Microsoft, so this falls back to the regex+validator pipeline
// matching the Nexus baseline detector (Luhn for CREDIT_CARD, mod-97 for
// IBAN, structural checks for the remainder).

export type DlpEntityType =
  | "US_SSN"
  | "CREDIT_CARD"
  | "EMAIL_ADDRESS"
  | "PHONE_NUMBER"
  | "US_PASSPORT"
  | "IBAN_CODE"
  | "IP_ADDRESS"
  | "US_DRIVER_LICENSE";

export const ALL_ENTITIES: DlpEntityType[] = [
  "US_SSN",
  "CREDIT_CARD",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "US_PASSPORT",
  "IBAN_CODE",
  "IP_ADDRESS",
  "US_DRIVER_LICENSE",
];

export type DlpAction = "log" | "warn" | "redact" | "block";

export type DlpFinding = {
  entityType: DlpEntityType;
  start: number;
  end: number;
  text: string;
  score: number;
  detector: string;
};

export type DlpScanResult = {
  findings: DlpFinding[];
  redactedText: string;
  reversalMap: Record<string, string>;
  appliedAction: DlpAction;
};

export type DlpScannerOptions = {
  defaultAction?: DlpAction;
  perChannel?: Record<string, DlpAction>;
  entities?: DlpEntityType[];
};

type PatternEntry = {
  entityType: DlpEntityType;
  pattern: RegExp;
  score: number;
  validator?: (match: string) => boolean;
};

function luhnOk(digits: string): boolean {
  if (!digits || !/^\d+$/.test(digits)) {
    return false;
  }
  let total = 0;
  const parity = digits.length % 2;
  for (let i = 0; i < digits.length; i++) {
    let n = Number(digits[i]);
    if (i % 2 === parity) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    total += n;
  }
  return total % 10 === 0;
}

function ibanMod97Ok(value: string): boolean {
  const s = value.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) {
    return false;
  }
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) {
    return false;
  }
  const rotated = s.slice(4) + s.slice(0, 4);
  const expanded: string[] = [];
  for (const ch of rotated) {
    if (ch >= "0" && ch <= "9") {
      expanded.push(ch);
    } else if (ch >= "A" && ch <= "Z") {
      expanded.push(String(ch.charCodeAt(0) - "A".charCodeAt(0) + 10));
    } else {
      return false;
    }
  }
  const joined = expanded.join("");
  let remainder = 0;
  for (const c of joined) {
    remainder = (remainder * 10 + Number(c)) % 97;
  }
  return remainder === 1;
}

function ipv4Ok(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) {
      return false;
    }
    const n = Number(p);
    if (n < 0 || n > 255) {
      return false;
    }
  }
  return true;
}

function ipv6Ok(value: string): boolean {
  return /^(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}$/.test(value);
}

const PATTERNS: PatternEntry[] = [
  {
    entityType: "EMAIL_ADDRESS",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    score: 0.95,
  },
  {
    entityType: "US_SSN",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    score: 0.9,
  },
  {
    entityType: "PHONE_NUMBER",
    pattern: /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
    score: 0.7,
  },
  {
    entityType: "US_PASSPORT",
    pattern: /\b[A-Z]\d{8}\b/g,
    score: 0.7,
  },
  {
    entityType: "US_DRIVER_LICENSE",
    pattern: /\b[A-Z]\d{7,8}\b/g,
    score: 0.6,
  },
  {
    entityType: "CREDIT_CARD",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    score: 0.95,
    validator: (match) => luhnOk(match.replace(/[\s-]/g, "")),
  },
  {
    entityType: "IBAN_CODE",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    score: 0.95,
    validator: (match) => ibanMod97Ok(match),
  },
  {
    entityType: "IP_ADDRESS",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b/g,
    score: 0.8,
    validator: (match) => ipv4Ok(match) || ipv6Ok(match),
  },
];

function spansOverlap(a: DlpFinding, b: DlpFinding): boolean {
  return !(a.end <= b.start || b.end <= a.start);
}

function dedupeFindings(findings: DlpFinding[]): DlpFinding[] {
  const sorted = findings.toSorted((x, y) => {
    if (x.start !== y.start) {
      return x.start - y.start;
    }
    const lenDiff = y.end - y.start - (x.end - x.start);
    if (lenDiff !== 0) {
      return lenDiff;
    }
    return y.score - x.score;
  });
  const kept: DlpFinding[] = [];
  for (const finding of sorted) {
    if (kept.some((existing) => spansOverlap(existing, finding))) {
      continue;
    }
    kept.push(finding);
  }
  return kept;
}

export class DlpScanner {
  private readonly entities: Set<DlpEntityType>;
  private readonly defaultAction: DlpAction;
  private readonly perChannel: Record<string, DlpAction>;

  constructor(opts: DlpScannerOptions = {}) {
    this.entities = new Set(opts.entities ?? ALL_ENTITIES);
    this.defaultAction = opts.defaultAction ?? "log";
    this.perChannel = { ...opts.perChannel };
  }

  resolveAction(channelId?: string | null): DlpAction {
    if (channelId && this.perChannel[channelId]) {
      return this.perChannel[channelId];
    }
    return this.defaultAction;
  }

  scan(text: string, opts: { channelId?: string | null } = {}): DlpScanResult {
    const action = this.resolveAction(opts.channelId ?? null);
    const findings: DlpFinding[] = [];
    if (typeof text !== "string" || text.length === 0) {
      return { findings: [], redactedText: text ?? "", reversalMap: {}, appliedAction: action };
    }

    for (const entry of PATTERNS) {
      if (!this.entities.has(entry.entityType)) {
        continue;
      }
      entry.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = entry.pattern.exec(text)) !== null) {
        const matched = match[0];
        if (matched.length === 0) {
          entry.pattern.lastIndex++;
          continue;
        }
        if (entry.validator && !entry.validator(matched)) {
          continue;
        }
        findings.push({
          entityType: entry.entityType,
          start: match.index,
          end: match.index + matched.length,
          text: matched,
          score: entry.score,
          detector: "regex",
        });
      }
    }

    const deduped = dedupeFindings(findings);
    const reversalMap: Record<string, string> = {};
    let redactedText = text;
    if (action === "redact") {
      const sortedDesc = deduped.toSorted((a, b) => b.start - a.start);
      for (const finding of sortedDesc) {
        const token = `[${finding.entityType}_REDACTED_${finding.start.toString(16)}]`;
        reversalMap[token] = finding.text;
        redactedText =
          redactedText.slice(0, finding.start) + token + redactedText.slice(finding.end);
      }
    }

    return { findings: deduped, redactedText, reversalMap, appliedAction: action };
  }
}
