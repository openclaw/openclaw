import type { Entity } from "../types.js";

interface PatternDef {
  label: string;
  pattern: RegExp;
}

const PATTERNS: PatternDef[] = [
  {
    label: "EMAIL",
    pattern:
      /(?<![A-Za-z0-9._%+\-@])(?![A-Za-z_]{2,20}=)[A-Za-z0-9!#$%&*+\-/=^_`{|}~][A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.]*@(?:\.?[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?=$|[^A-Za-z])/gi,
  },
  {
    label: "PHONE",
    pattern:
      /(?<![A-Za-z0-9])(?:(?:(?:\+?1)[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[\s\-.]?\d{1,4}(?:[\s\-.]?\d{2,4}){2,3})(?![-A-Za-z0-9])/gi,
  },
  {
    label: "SSN",
    pattern:
      /(?<!\d)(?:(?!000|666)\d{3}-(?!00)\d{2}-(?!0000)\d{4}|(?!000|666)\d{3}(?!00)\d{2}(?!0000)\d{4})(?!\d)/g,
  },
  {
    label: "CREDIT_CARD",
    pattern:
      /\b(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|(?:(?:4\d{3}|5[1-5]\d{2}|3[47]\d{2})[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4})|(?:3[47]\d{2}[-\s]?\d{6}[-\s]?\d{5}))\b/g,
  },
  {
    label: "IP_ADDRESS",
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d)\.(?:25[0-5]|2[0-4]\d|1?\d?\d))\b/g,
  },
  {
    label: "DATE",
    pattern:
      /\b(?:(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:\d{2}|\d{4})|(?:\d{4})-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\d|3[01])|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:0?[1-9]|[12]\d|3[01]),\s+(?:19|20)\d{2})\b/gi,
  },
  {
    label: "ZIP_CODE",
    pattern: /\b\d{5}(?:-\d{4})?\b/g,
  },
];

export class RegexEngine {
  scan(text: string): Entity[] {
    const entities: Entity[] = [];

    for (const { label, pattern } of PATTERNS) {
      // Reset lastIndex to avoid stale state from previous calls
      pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.exec(text)) !== null) {
        entities.push({
          text: match[0],
          label,
          start: match.index,
          end: match.index + match[0].length,
          confidence: 1.0,
          source: "regex",
        });
      }
    }

    // Sort by start position for deterministic output
    entities.sort((a, b) => a.start - b.start || a.end - b.end);

    return entities;
  }
}
