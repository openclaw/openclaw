// Adapted from Hermes Agent; see THIRD_PARTY_NOTICES.md for the pinned source and MIT license.
const MIXTURE_DOMINANT_FRACTION = 0.85;
const MIXTURE_DISTINCT_FRACTION = 0.95;
const FIRST_CHECK_CHARS = 16_000;
const TAIL_CHARS = 64_000;
const WINDOW_CHARS = 60;
const MIN_REPEATS = 5;

const RECORD_SHAPE_FRACTION = 0.8;

function parseDelimitedRecords(
  text: string,
  delimiter: string,
  startsMidLine: boolean,
  initiallyInQuotes = false,
): { counts: Map<number, number>; total: number } {
  const counts = new Map<number, number>();
  let total = 0;
  let fieldCount = 1;
  let fieldText = "";
  let hasContent = false;
  let valid = true;
  let inQuotes = initiallyInQuotes;
  let closedQuote = false;
  let recordIndex = 0;
  const finish = (countRecord: boolean) => {
    if (hasContent && countRecord && (!startsMidLine || recordIndex > 0)) {
      total++;
      if (valid && fieldCount >= 2) {
        counts.set(fieldCount, (counts.get(fieldCount) ?? 0) + 1);
      }
    }
    fieldCount = 1;
    fieldText = "";
    hasContent = false;
    valid = true;
    closedQuote = false;
    recordIndex++;
  };
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (inQuotes) {
      hasContent = true;
      if (char === '"') {
        if (text[index + 1] === '"') {
          index++;
        } else {
          inQuotes = false;
          closedQuote = true;
        }
      }
      continue;
    }
    if (char === "\r" || char === "\n") {
      finish(true);
      continue;
    }
    hasContent = true;
    if (closedQuote) {
      if (char === delimiter) {
        fieldCount++;
        fieldText = "";
        closedQuote = false;
        continue;
      }
      if (/\s/.test(char)) {
        continue;
      }
      valid = false;
    }
    if (char === delimiter) {
      fieldCount++;
      fieldText = "";
    } else if (char === '"' && fieldText.trim() === "") {
      inQuotes = true;
      fieldText = "";
    } else {
      fieldText += char;
    }
  }
  finish(false);
  return { counts, total };
}

function hasConsistentRecordShape(text: string, startsMidLine: boolean): boolean {
  // Delimited text can be categorical data or prose; do not truncate either possibility.
  for (const delimiter of [",", "\t", "|"]) {
    for (const initiallyInQuotes of startsMidLine ? [false, true] : [false]) {
      const { counts, total } = parseDelimitedRecords(
        text,
        delimiter,
        startsMidLine,
        initiallyInQuotes,
      );
      for (const count of counts.values()) {
        if (count >= MIN_REPEATS && count >= total * RECORD_SHAPE_FRACTION) {
          return true;
        }
      }
    }
  }
  return false;
}

function isNumericListLine(line: string): boolean {
  const content = line.endsWith(",") ? line.slice(0, -1) : line;
  return content
    .split(",")
    .every((field) => /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(field.trim()));
}

function isStructuredLine(line: string): boolean {
  return (
    line === "---" ||
    line.startsWith("<") ||
    line.startsWith('"') ||
    line.startsWith("'") ||
    line.startsWith("{") ||
    line.startsWith("}") ||
    line.startsWith("[") ||
    line.startsWith("]") ||
    line.startsWith("- ") ||
    line.endsWith("{") ||
    line.endsWith("}") ||
    line.endsWith(";") ||
    line.includes("=>") ||
    line.includes("=") ||
    isNumericListLine(line) ||
    /^(?:true|false|null),?$/.test(line) ||
    /^(?:["'][^"']+["']|[A-Za-z_][\w-]*)\s*:/.test(line)
  );
}

function isRepetitionDominated(text: string, startsMidLine: boolean): boolean {
  const lines = text.split(/\r\n|[\r\n]/);
  const counts = new Map<string, number>();
  const completeCounts = new Map<string, number>();
  let lineCount = 0;
  let completeLineCount = 0;
  let structuredLineCount = 0;
  for (const [index, line] of lines.entries()) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    lineCount++;
    if (index >= (startsMidLine ? 1 : 0) && index < lines.length - 1) {
      completeCounts.set(normalized, (completeCounts.get(normalized) ?? 0) + 1);
      completeLineCount++;
      if (isStructuredLine(normalized)) {
        structuredLineCount++;
      }
    }
  }
  // Similar prefixes in distinct records are not a loop, even when their windows repeat.
  if (lineCount >= MIN_REPEATS && counts.size > lineCount / 2) {
    return false;
  }
  const dominantChars = text.length / 2;
  let repeatedLineChars = 0;
  for (const [line, count] of counts) {
    if (count >= MIN_REPEATS) {
      repeatedLineChars = Math.max(repeatedLineChars, line.length * count);
    }
  }
  if (repeatedLineChars >= dominantChars) {
    return true;
  }
  let mixtureRepeatedChars = 0;
  let repeatedDistinctLines = 0;
  for (const [line, count] of completeCounts) {
    if (count >= MIN_REPEATS) {
      mixtureRepeatedChars += line.length * count;
      repeatedDistinctLines++;
    }
  }
  // Aggregate only plain prose: structured records and valid categorical CSV keep
  // their existing protection. Boundary fragments affect only the novelty share;
  // every received character remains in the coverage denominator (#182834).
  if (
    completeCounts.size > 0 &&
    structuredLineCount * 2 < completeLineCount &&
    !hasConsistentRecordShape(text, startsMidLine) &&
    mixtureRepeatedChars >= text.length * MIXTURE_DOMINANT_FRACTION &&
    repeatedDistinctLines >= completeCounts.size * MIXTURE_DISTINCT_FRACTION
  ) {
    return true;
  }

  const windows = new Map<string, { count: number; end: number }>();
  const needed = Math.max(MIN_REPEATS, Math.ceil(dominantChars / WINDOW_CHARS));
  for (let start = 0; start <= text.length - WINDOW_CHARS; start++) {
    const window = text.slice(start, start + WINDOW_CHARS);
    const previous = windows.get(window);
    if (previous && start < previous.end) {
      continue;
    }
    const count = (previous?.count ?? 0) + 1;
    if (count >= needed) {
      return true;
    }
    windows.set(window, { count, end: start + WINDOW_CHARS });
  }

  // Sample exact periods as well: a long repeated unit can have few equal 60-char windows.
  const lastStart = text.length - WINDOW_CHARS;
  const step = Math.max(1, Math.ceil(lastStart / 31));
  for (let sample = 0; sample <= 31; sample++) {
    const start = Math.min(sample * step, lastStart);
    const anchor = text.slice(start, start + WINDOW_CHARS);
    let match = start;
    for (let attempt = 0; attempt < 8; attempt++) {
      match = text.indexOf(anchor, match + 1);
      if (match < 0) {
        break;
      }
      const period = match - start;
      let left = start;
      let right = start + WINDOW_CHARS;
      while (left > 0 && text[left - 1] === text[left - 1 + period]) {
        left--;
      }
      while (right + period < text.length && text[right] === text[right + period]) {
        right++;
      }
      const coverage = right + period - left;
      if (coverage >= MIN_REPEATS * period && coverage >= dominantChars) {
        return true;
      }
    }
    if (start === lastStart) {
      break;
    }
  }
  return false;
}

/** Hermes-inspired long-output guard, scoped to one visible-text or reasoning block. */
export class RepetitionWatch {
  private parts: string[] = [];
  private chars = 0;
  private nextCheck = FIRST_CHECK_CHARS;
  private stopped = false;

  feed(delta: string): boolean {
    if (this.stopped) {
      return true;
    }
    let offset = 0;
    while (offset < delta.length) {
      const end = Math.min(delta.length, offset + this.nextCheck - this.chars);
      this.parts.push(delta.slice(offset, end));
      this.chars += end - offset;
      offset = end;
      if (this.chars === this.nextCheck) {
        const tail = this.parts.join("").slice(-TAIL_CHARS);
        this.parts = [tail];
        this.nextCheck += Math.min(this.chars, TAIL_CHARS);
        if (isRepetitionDominated(tail, this.chars > tail.length)) {
          this.stopped = true;
          return true;
        }
      }
    }
    return false;
  }
}
