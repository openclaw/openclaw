// Adapted from Hermes Agent; see THIRD_PARTY_NOTICES.md for the pinned source and MIT license.
const FIRST_CHECK_CHARS = 16_000;
const TAIL_CHARS = 64_000;
const WINDOW_CHARS = 60;
const MIN_REPEATS = 5;

function isRepetitionDominated(text: string): boolean {
  const counts = new Map<string, number>();
  let lineCount = 0;
  for (const line of text.split(/\r\n|[\r\n]/)) {
    const normalized = line.trim();
    if (normalized) {
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      lineCount++;
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
        if (isRepetitionDominated(tail)) {
          this.stopped = true;
          return true;
        }
      }
    }
    return false;
  }
}
