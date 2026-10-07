import {
  MAX_SESSION_PREVIEW_LENGTH,
  SESSION_PREVIEW_PREFIX_LENGTH,
} from "../session-catalog-parsing.js";

type ObjectFrame = {
  kind: "object";
  expect: "key" | "colon" | "value" | "comma";
  lastKey?: string;
};
type ArrayFrame = {
  kind: "array";
  expect: "value" | "comma";
};
type Frame = ObjectFrame | ArrayFrame;

export type CodexCatalogPreviewBoundLimits = {
  /** Decoded units the canonical selector inspects before it may drop the tail. */
  prefixUnits: number;
  /** Display length; the retained text must determine at least this many units plus lookahead. */
  displayUnits: number;
  /** Raw JSON characters kept when the prefix cannot determine the display text. */
  maxRawChars: number;
};

// 64 rows x 64 KiB stays well below the decoder's incomplete-frame recovery cap.
const DEFAULT_LIMITS: CodexCatalogPreviewBoundLimits = {
  prefixUnits: SESSION_PREVIEW_PREFIX_LENGTH,
  displayUnits: MAX_SESSION_PREVIEW_LENGTH,
  maxRawChars: 64 * 1024,
};

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Drop the tail of native `preview` strings before JSON.parse so catalog pages stay bounded.
 *
 * The tail is only dropped once the retained prefix fixes the displayed preview: at least
 * the canonical selector's prefix, no terminal controls, and more than the display length
 * of collapsed, trimmed text. Whitespace after the first unit of a run is dropped as it is
 * read, since the projection collapses each run to one space. Controls before the first
 * ANSI introducer are deleted by the sanitizer, so runs of them shrink to one unit. Only
 * previews whose ANSI sequences keep the display undetermined are cut at `maxRawChars`.
 */
export class CodexCatalogPreviewBounder {
  private inString = false;
  private escape = false;
  private unicodeLeft = 0;
  private unicodeHex = "";
  private capturingKey = false;
  private currentKey = "";
  private previewValue = false;
  private previewRawChars = 0;
  private previewUnits = 0;
  private previewTextUnits = 0;
  private previewHasText = false;
  private previewPendingSpace = false;
  private previewHasControl = false;
  private previewInWhitespace = false;
  private previewInControlRun = false;
  private escapeStart = -1;
  private skipping = false;
  private readonly stack: Frame[] = [];
  private readonly limits: CodexCatalogPreviewBoundLimits;

  constructor(limits: Partial<CodexCatalogPreviewBoundLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get isSkipping(): boolean {
    return this.skipping;
  }

  /** Whether the next input continues a native preview string. */
  get isInPreview(): boolean {
    return this.inString && this.previewValue;
  }

  reset(): void {
    this.inString = false;
    this.resetString();
    this.capturingKey = false;
    this.currentKey = "";
    this.previewValue = false;
    this.skipping = false;
    this.stack.length = 0;
  }

  push(chunk: string): string {
    if (!chunk) {
      return chunk;
    }
    const kept: string[] = [];
    let start = 0;
    this.escapeStart = -1;
    if (this.isInPreview && !this.skipping && !this.escape && this.unicodeLeft === 0) {
      // The message decoder joins a preview that spans lines with an escaped newline.
      if (this.notePreviewUnit("\n", 2, false) === "stop") {
        this.skipping = true;
      }
    }
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]!;
      if (this.skipping) {
        if (this.decodeEscape(character) !== undefined) {
          continue;
        }
        if (character === "\\") {
          this.escape = true;
          continue;
        }
        if (character === '"') {
          this.finishString();
          start = index;
        }
        continue;
      }
      if (this.inString) {
        const escaped = this.decodeEscape(character);
        let unit: string | undefined;
        let unitStart = index;
        if (escaped !== undefined) {
          unit = escaped || undefined;
          unitStart = this.escapeStart;
        } else if (character === "\\") {
          this.escape = true;
          this.escapeStart = index;
        } else if (character === '"') {
          this.finishString();
          continue;
        } else {
          unit = character;
        }
        if (this.capturingKey) {
          this.currentKey += character;
          continue;
        }
        if (!this.previewValue || unit === undefined) {
          continue;
        }
        // An escape that began in an earlier chunk was already emitted, so it stays.
        const action = this.notePreviewUnit(
          unit,
          unitStart >= 0 ? index + 1 - unitStart : 0,
          unitStart >= 0,
        );
        if (action === "drop") {
          kept.push(chunk.slice(start, unitStart));
          start = index + 1;
        } else if (action === "stop") {
          kept.push(chunk.slice(start, index + 1));
          start = chunk.length;
          this.skipping = true;
        }
        continue;
      }
      if (character === '"') {
        this.beginString();
        continue;
      }
      if (character === "{") {
        this.finishValue();
        this.stack.push({ kind: "object", expect: "key" });
        continue;
      }
      if (character === "[") {
        this.finishValue();
        this.stack.push({ kind: "array", expect: "value" });
        continue;
      }
      if (character === "}") {
        if (this.stack.at(-1)?.kind === "object") {
          this.stack.pop();
        }
        this.afterValue();
        continue;
      }
      if (character === "]") {
        if (this.stack.at(-1)?.kind === "array") {
          this.stack.pop();
        }
        this.afterValue();
        continue;
      }
      if (character === ":") {
        const frame = this.stack.at(-1);
        if (frame?.kind === "object" && frame.expect === "colon") {
          frame.expect = "value";
        }
        continue;
      }
      if (character === ",") {
        const frame = this.stack.at(-1);
        if (frame) {
          frame.expect = frame.kind === "object" ? "key" : "value";
          if (frame.kind === "object") {
            frame.lastKey = undefined;
          }
        }
        continue;
      }
    }
    if (start < chunk.length && !this.skipping) {
      kept.push(chunk.slice(start));
    }
    return kept.join("");
  }

  private resetString(): void {
    this.escape = false;
    this.unicodeLeft = 0;
    this.unicodeHex = "";
    this.previewRawChars = 0;
    this.previewUnits = 0;
    this.previewTextUnits = 0;
    this.previewHasText = false;
    this.previewPendingSpace = false;
    this.previewHasControl = false;
    this.previewInWhitespace = false;
    this.previewInControlRun = false;
  }

  private beginString(): void {
    const frame = this.stack.at(-1);
    this.inString = true;
    this.resetString();
    this.capturingKey = frame?.kind === "object" && frame.expect === "key";
    this.currentKey = "";
    this.previewValue =
      frame?.kind === "object" && frame.expect === "value" && frame.lastKey === "preview";
    this.skipping = false;
  }

  private finishString(): void {
    const frame = this.stack.at(-1);
    this.inString = false;
    this.resetString();
    this.skipping = false;
    if (this.capturingKey && frame?.kind === "object") {
      frame.lastKey = this.currentKey;
      frame.expect = "colon";
    } else {
      this.afterValue();
    }
    this.capturingKey = false;
    this.currentKey = "";
    this.previewValue = false;
  }

  private finishValue(): void {
    const frame = this.stack.at(-1);
    if (frame?.expect === "value") {
      frame.expect = "comma";
      if (frame.kind === "object") {
        frame.lastKey = undefined;
      }
    }
  }

  private afterValue(): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    frame.expect = "comma";
    if (frame.kind === "object") {
      frame.lastKey = undefined;
    }
  }

  /** Decide whether a decoded preview unit is kept, dropped, or ends the retained prefix. */
  private notePreviewUnit(
    unit: string,
    rawLength: number,
    droppable: boolean,
  ): "keep" | "drop" | "stop" {
    // Mirror the canonical projection: whitespace runs collapse to one space and trim.
    if (/\s/u.test(unit)) {
      if (this.previewInWhitespace && droppable) {
        return "drop";
      }
      this.previewInWhitespace = true;
      this.previewInControlRun = false;
      this.previewPendingSpace = this.previewHasText;
    } else if (!this.previewHasControl && isRemovableControl(unit)) {
      // Before any ANSI introducer the sanitizer deletes these in place, so one per run
      // keeps adjacent whitespace runs apart and the rest can go.
      if (this.previewInControlRun && droppable) {
        return "drop";
      }
      this.previewInWhitespace = false;
      this.previewInControlRun = true;
    } else {
      this.previewInWhitespace = false;
      this.previewInControlRun = false;
      this.previewTextUnits += this.previewPendingSpace ? 2 : 1;
      this.previewPendingSpace = false;
      this.previewHasText = true;
      this.previewHasControl ||= /\p{Cc}/u.test(unit);
    }
    this.previewUnits++;
    this.previewRawChars += rawLength;
    if (this.previewRawChars >= this.limits.maxRawChars) {
      return "stop";
    }
    // One extra unit keeps truncateUtf16Safe's surrogate lookahead at the display boundary.
    return !this.previewHasControl &&
      this.previewUnits >= this.limits.prefixUnits &&
      this.previewTextUnits > this.limits.displayUnits + 1
      ? "stop"
      : "keep";
  }

  /**
   * Consume one escape character. Returns the decoded unit when an escape completes, "" while
   * a \u escape is still pending, and undefined when no escape is in progress.
   */
  private decodeEscape(character: string): string | undefined {
    if (this.unicodeLeft > 0) {
      this.unicodeHex += character;
      this.unicodeLeft--;
      if (this.unicodeLeft > 0) {
        return "";
      }
      this.escape = false;
      const unit = String.fromCharCode(Number.parseInt(this.unicodeHex, 16));
      this.unicodeHex = "";
      return unit;
    }
    if (!this.escape) {
      return undefined;
    }
    if (character === "u") {
      this.unicodeLeft = 4;
      this.unicodeHex = "";
      return "";
    }
    this.escape = false;
    return SIMPLE_ESCAPES[character] ?? character;
  }
}

/** Controls the sanitizer drops without effect while no ANSI introducer precedes them. */
function isRemovableControl(unit: string): boolean {
  return /\p{Cc}/u.test(unit) && unit !== "\u001b" && unit !== "\u009b" && unit !== "\u009d";
}
